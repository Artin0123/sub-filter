import { dedupRecords } from './dedup';
import { fetchSource } from './fetchers';
import { sha256Hex } from './hash';
import { KV_KEYS, putIfChanged } from './kv';
import { mapWithConcurrency } from './lib/async';
import type { AppEnv } from './lib/env';
import { normalizeChunkSize } from './services/config';
import { getSourceFilters, listSources } from './services/source-store';
import { maybeDecodeBulkBase64, parseSubscriptionText, parseUriToRecord, safeBase64EncodeUtf8, type NormalizedRecord } from './subscription';

export type RefreshResult = {
	updated: boolean;
	records: number;
	chunks: { total: number; size: number };
	perSource: { ok: number; fail: number };
	// 失敗來源的原因，避免只看到一個 fail 計數而不知道為什麼。
	failedSources: { url: string; error: string }[];
	changedChunks: number[];
	debug?: {
		linesTotal: number;
		parsedByScheme: Record<string, number>;
		failedByScheme: Record<string, number>;
		duplicates: number;
		// 被來源協議過濾掉的節點數（已解析成功但不在勾選清單內）。
		filteredOut: number;
		chunkLineCounts: number[];
	};
};

// 外部來源抓取上限：避免一次打爆遠端站點，也避免 Worker 等待過久。
const SOURCE_CONCURRENCY = 5;
// KV 寫入併發上限：夠快，又不會把配額用量瞬間打滿。
const KV_WRITE_CONCURRENCY = 5;
// 分塊 hash 是純 CPU 工作，併發一點即可。
const HASH_CONCURRENCY = 8;
// Cloudflare KV 單次多鍵 get 上限是 100 個 key，超過必須分批。
const KV_MULTI_GET_LIMIT = 100;
const KV_MULTI_GET_CONCURRENCY = 3;

async function readExistingEtags(env: AppEnv, keys: string[]): Promise<Map<string, string | null>> {
	const merged = new Map<string, string | null>();
	if (keys.length === 0) return merged;

	const batches: string[][] = [];
	for (let i = 0; i < keys.length; i += KV_MULTI_GET_LIMIT) {
		batches.push(keys.slice(i, i + KV_MULTI_GET_LIMIT));
	}

	const results = await mapWithConcurrency(batches, KV_MULTI_GET_CONCURRENCY, (batch) =>
		env.KV_NAMESPACE.get(batch, 'text'),
	);
	for (const batch of results) {
		for (const [key, value] of batch) merged.set(key, value);
	}
	return merged;
}

export async function runUpdate(env: AppEnv): Promise<RefreshResult> {
	const urls = (await listSources(env)).filter((s) => typeof s === 'string' && s.trim().length > 0);
	const chunkSize = normalizeChunkSize(await env.KV_NAMESPACE.get(KV_KEYS.chunkSize));
	const shouldBase64Encode = (await env.KV_NAMESPACE.get(KV_KEYS.base64Encode)) === '1';

	// Base64 開關切換時，必須強制重寫所有分塊；否則內容格式改了但 ETag 不一定全更新。
	// 第一次執行（KV 還沒有旗標）也算一次變更，順便建立旗標。
	const currentBase64Setting = shouldBase64Encode ? '1' : '0';
	const lastBase64Setting = await env.KV_NAMESPACE.get(KV_KEYS.lastBase64Setting);
	const base64SettingChanged = lastBase64Setting !== currentBase64Setting;

	const fetched = await mapWithConcurrency(urls, SOURCE_CONCURRENCY, (url) => fetchSource(url));
	let ok = 0;
	let fail = 0;
	const texts: { url: string; text: string }[] = [];
	const failedSources: { url: string; error: string }[] = [];
	for (const result of fetched) {
		// 空內容也是「抓取成功」，只是沒有節點；不可計入 fail。
		if (result.ok && result.text !== undefined) {
			ok++;
			if (result.text) texts.push({ url: result.url, text: result.text });
		} else {
			fail++;
			failedSources.push({ url: result.url, error: result.error ?? `http_${result.status}` });
		}
	}

	// 來源內容可能本來就是批量 Base64 訂閱，因此先解碼再逐行解析。
	const records: NormalizedRecord[] = [];
	let linesTotal = 0;
	const parsedByScheme: Record<string, number> = {};
	const failedByScheme: Record<string, number> = {};
	let filteredOut = 0;
	const filters = await getSourceFilters(env);
	for (const { url, text } of texts) {
		// 該來源有設定協議過濾時，只保留勾選的類型；沒設定就全部保留。
		const allowed = filters[url]?.length ? new Set<string>(filters[url]) : null;
		const body = maybeDecodeBulkBase64(text);
		const lines = parseSubscriptionText(body);
		linesTotal += lines.length;

		for (const line of lines) {
			const scheme = (line.split(':', 1)[0] || '').toLowerCase();
			const rec = parseUriToRecord(line);
			if (rec) {
				if (!allowed || allowed.has(rec.type)) records.push(rec);
				else filteredOut++;
			}
			(rec ? parsedByScheme : failedByScheme)[scheme || 'unknown'] = ((rec ? parsedByScheme : failedByScheme)[scheme || 'unknown'] || 0) + 1;
		}
	}

	// 去重後直接輸出原始 URI，避免改動節點本身的連線參數。
	const unique = dedupRecords(records);
	const encodedLines = unique.map((record) => record.rawUri);

	const chunks: string[] = [];
	const chunkLineCounts: number[] = [];
	for (let i = 0; i < encodedLines.length; i += chunkSize) {
		const slice = encodedLines.slice(i, i + chunkSize);
		const joined = slice.join('\n');
		chunks.push(shouldBase64Encode ? safeBase64EncodeUtf8(joined) : joined);
		chunkLineCounts.push(slice.length);
	}

	const newTotal = chunks.length;
	const oldTotalRaw = await env.KV_NAMESPACE.get(KV_KEYS.chunksTotal);
	const oldTotal = parseInt(oldTotalRaw ?? '0', 10) || 0;

	// 先分批讀回所有既有 ETag，再決定哪些分塊真的要寫。
	const etagKeys = chunks.map((_, i) => KV_KEYS.etagI(i + 1));
	const existingEtags = await readExistingEtags(env, etagKeys);
	const newEtags = await mapWithConcurrency(chunks, HASH_CONCURRENCY, (content) => sha256Hex(content));

	const changedChunks: number[] = [];
	for (let i = 0; i < chunks.length; i++) {
		// 只有 ETag 變化或 Base64 設定切換時才重寫，減少 KV 寫入量。
		if (base64SettingChanged || (existingEtags.get(etagKeys[i]) ?? null) !== newEtags[i]) {
			changedChunks.push(i + 1);
		}
	}

	// 先寫內容再寫 ETag：讀者若在中途進來，只會看到「舊 ETag + 新內容」，
	// 下一次請求就會因為 ETag 不符而重抓，不會把新內容配上新 ETag 快取起來。
	await mapWithConcurrency(changedChunks, KV_WRITE_CONCURRENCY, async (n) => {
		await env.KV_NAMESPACE.put(KV_KEYS.subTxtI(n), chunks[n - 1]);
		await env.KV_NAMESPACE.put(KV_KEYS.etagI(n), newEtags[n - 1]);
	});

	// 當來源變少時，需要清掉多出來的舊分塊，否則舊 URL 仍然可讀。
	if (oldTotal > newTotal) {
		const stale = Array.from({ length: oldTotal - newTotal }, (_, i) => newTotal + i + 1);
		await mapWithConcurrency(stale, KV_WRITE_CONCURRENCY, async (n) => {
			await env.KV_NAMESPACE.delete(KV_KEYS.subTxtI(n));
			await env.KV_NAMESPACE.delete(KV_KEYS.etagI(n));
		});
	}

	// 內容沒變的刷新不應該消耗寫入額度：只有真的變了才寫 chunks_total / last_updated_iso。
	if (oldTotalRaw !== String(newTotal)) await env.KV_NAMESPACE.put(KV_KEYS.chunksTotal, String(newTotal));
	if (changedChunks.length > 0 || oldTotal !== newTotal) {
		await env.KV_NAMESPACE.put(KV_KEYS.lastUpdatedISO, new Date().toISOString());
	}

	const duplicates = records.length - unique.length;
	const debugInfo = { linesTotal, parsedByScheme, failedByScheme, duplicates, filteredOut, chunkLineCounts };
	await putIfChanged(env.KV_NAMESPACE, KV_KEYS.lastStats, JSON.stringify(debugInfo));

	// 這個旗標一定要在分塊全部寫成功之後才更新：
	// 若中途失敗就提前翻新，下一次刷新會誤以為「編碼沒變」而不重寫，導致內容永久停在舊編碼。
	if (base64SettingChanged) {
		await env.KV_NAMESPACE.put(KV_KEYS.lastBase64Setting, currentBase64Setting);
	}

	return {
		updated: changedChunks.length > 0 || oldTotal !== newTotal,
		records: unique.length,
		chunks: { total: newTotal, size: chunkSize },
		perSource: { ok, fail },
		failedSources,
		changedChunks,
		debug: debugInfo,
	};
}
