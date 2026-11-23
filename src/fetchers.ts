// 來源抓取封裝。
// 這裡集中處理「來源 → 文字」的所有細節：scheme 分流、私網位址封鎖、timeout、大小上限與少量 retry，
// 讓更新管線只需要面對 `fetchSource()` 一個入口。
import { safeBase64Decode } from './subscription';

export type FetchResult = {
	url: string;
	ok: boolean;
	status: number;
	text?: string;
	error?: string;
	// 只有「重試可能成功」的失敗才為 true（網路錯、408、429、5xx）。
	retryable?: boolean;
};

export type SourceKind = 'http' | 'inline' | 'data';

export const DEFAULT_TIMEOUT_MS = 10_000;
// 單一來源的內容上限，避免惡意或異常巨大的回應把 Worker 記憶體打爆。
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

const RETRY_DELAY_MS = 300;

export function classifySource(url: string): SourceKind | null {
	if (/^https?:\/\//i.test(url)) return 'http';
	if (/^inline:/i.test(url)) return 'inline';
	if (/^data:/i.test(url)) return 'data';
	return null;
}

function isBlockedIpv4(host: string): boolean {
	const parts = host.split('.');
	if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return false;
	const first = Number(parts[0]);
	const second = Number(parts[1]);
	if (parts.some((part) => Number(part) > 255)) return false;

	if (first === 0 || first === 10 || first === 127) return true;
	if (first === 100 && second >= 64 && second <= 127) return true; // CGNAT
	if (first === 169 && second === 254) return true; // link-local（含雲端 metadata）
	if (first === 172 && second >= 16 && second <= 31) return true;
	if (first === 192 && second === 168) return true;
	if (first === 198 && (second === 18 || second === 19)) return true; // benchmark
	if (first >= 224) return true; // multicast / reserved / broadcast
	return false;
}

function isBlockedIpv6(host: string): boolean {
	const h = host.replace(/^\[|\]$/g, '').toLowerCase();
	if (h === '::' || h === '::1') return true;
	if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique local
	if (/^fe[89ab]/.test(h)) return true; // link-local
	if (h.startsWith('ff')) return true; // multicast

	// 內嵌 IPv4 的轉換形式：NAT64（含 well-known 與 local-use）與 6to4，整段封鎖。
	if (h.startsWith('64:ff9b:')) return true;
	if (h.startsWith('2002:')) return true;

	// WHATWG URL 會把 IPv4-mapped 位址壓成 `::ffff:c0a8:101` 這種形式。
	const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (mapped) {
		const hi = parseInt(mapped[1], 16);
		const lo = parseInt(mapped[2], 16);
		return isBlockedIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
	}
	return false;
}

/**
 * 判斷 http(s) 來源是否指向不可抓取的位址。
 * `new URL()` 會先把十進位 / 十六進位 / 簡寫形式（例如 `2130706433`、`0x7f.1`）正規化成標準 IPv4，
 * 因此只要檢查正規化後的 hostname 就能擋掉這些繞道寫法。
 */
export function isBlockedHttpTarget(url: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return true;
	}
	if (!hostname) return true;
	if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
	if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
	if (hostname.startsWith('[') || hostname.includes(':')) return isBlockedIpv6(hostname);
	return isBlockedIpv4(hostname);
}

export async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
	const ac = new AbortController();
	const id = setTimeout(() => ac.abort('timeout'), ms);
	try {
		return await fetch(url, {
			signal: ac.signal,
			headers: { accept: 'text/plain, */*', 'user-agent': 'sub-filter' },
		});
	} finally {
		clearTimeout(id);
	}
}

// 串流讀取並在超過上限時中止，避免 Content-Length 缺失（chunked）時無法預先判斷。
async function readTextWithLimit(res: Response, maxBytes: number): Promise<string | null> {
	const declared = Number(res.headers.get('content-length') || 0);
	if (Number.isFinite(declared) && declared > maxBytes) return null;
	if (!res.body) return '';

	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}

	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}

function isRetryableStatus(status: number): boolean {
	return status === 0 || status === 408 || status === 429 || status >= 500;
}

export async function fetchOnce(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<FetchResult> {
	try {
		const res = await fetchWithTimeout(url, timeoutMs);
		const text = await readTextWithLimit(res, MAX_SOURCE_BYTES);
		if (text === null) {
			return { url, ok: false, status: res.status, error: 'too_large', retryable: false };
		}
		return { url, ok: res.ok, status: res.status, text, retryable: !res.ok && isRetryableStatus(res.status) };
	} catch (e) {
		const message = String(e);
		const timedOut = /abort|timeout/i.test(message);
		return { url, ok: false, status: 0, error: timedOut ? 'timeout' : message, retryable: true };
	}
}

export async function fetchWithRetry(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<FetchResult> {
	const first = await fetchOnce(url, timeoutMs);
	// 只重試「可能自己好起來」的失敗（網路錯 / 429 / 5xx），404、403 重試只是浪費時間。
	if (first.ok || !first.retryable) return first;
	await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
	return fetchOnce(url, timeoutMs);
}

function decodeDataSource(url: string): string | null {
	const comma = url.indexOf(',');
	// 沒有逗號的 data: 是畸形輸入，直接視為失敗，避免把整段 metadata 當內容解析。
	if (comma < 0) return null;
	const meta = url.slice(0, comma);
	const payload = url.slice(comma + 1);
	if (/;base64$/i.test(meta)) return safeBase64Decode(payload);
	try {
		return decodeURIComponent(payload);
	} catch {
		return null;
	}
}

function tooLarge(url: string, text: string): FetchResult | null {
	if (new TextEncoder().encode(text).byteLength <= MAX_SOURCE_BYTES) return null;
	return { url, ok: false, status: 0, error: 'too_large', retryable: false };
}

/**
 * 唯一個來源抓取入口：依 scheme 分流到 inline / data / HTTP。
 * 不支援的 scheme 與指向私網的 http(s) 來源都會直接標記失敗，不會落到 `fetch()`。
 */
export async function fetchSource(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<FetchResult> {
	const kind = classifySource(url);
	if (kind === 'inline') {
		const text = url.slice('inline:'.length);
		return tooLarge(url, text) ?? { url, ok: true, status: 200, text };
	}
	if (kind === 'data') {
		const text = decodeDataSource(url);
		if (text === null) return { url, ok: false, status: 0, error: 'invalid_data_url', retryable: false };
		return tooLarge(url, text) ?? { url, ok: true, status: 200, text };
	}
	if (kind === 'http') {
		if (isBlockedHttpTarget(url)) return { url, ok: false, status: 0, error: 'blocked_host', retryable: false };
		return fetchWithRetry(url, timeoutMs);
	}
	return { url, ok: false, status: 0, error: 'unsupported_scheme', retryable: false };
}
