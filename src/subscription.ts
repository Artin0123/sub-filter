// 訂閱內容解析。
// 這一層只抽出去重與統計需要的欄位，並保留原始 URI 供最終輸出。
export type NormalizedRecord = {
	type: 'vmess' | 'vless' | 'trojan' | 'ss' | 'hysteria2';
	rawUri: string;
	server: string;
	port: number;
	servername?: string;
	sni?: string;
	password?: string;
	method?: string;
	uuid?: string;
	tls?: boolean;
	reality?: boolean;
	name?: string;
	tag?: string;
	obfs?: string;
	obfsPassword?: string;
	insecure?: boolean;
	pinSHA256?: string;
};

export function safeBase64Decode(input: string): string | null {
	try {
		const pad = input.length % 4 === 2 ? '==' : input.length % 4 === 1 ? '===' : input.length % 4 === 3 ? '=' : '';
		const s = atob(input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/') + pad);
		return new TextDecoder().decode(Uint8Array.from(s, c => c.charCodeAt(0)));
	} catch {
		return null;
	}
}

export function safeBase64EncodeUtf8(input: string): string {
	// 先轉 UTF-8 bytes 再做 Base64，避免直接處理 JS 字串時出現非 ASCII 亂碼。
	const bytes = new TextEncoder().encode(input);
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}

export function parseSubscriptionText(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith('#'));
}

export function maybeDecodeBulkBase64(text: string): string {
	// 只有在內容看起來不像已帶協議前綴時，才嘗試當作批量 Base64 訂閱解碼。
	if (/:\/\//.test(text)) {
		return text;
	}

	const decoded = safeBase64Decode(text);
	// 解碼成功後仍要再次確認內容像真正的代理 URI，而不是任意文字。
	if (decoded && /(?:vmess|vless|trojan|ss|ssr|hysteria|tuic):\/\//.test(decoded)) {
		return decoded;
	}

	return text;
}

export function parseUriToRecord(uri: string): NormalizedRecord | null {
	try {
		const scheme = uri.split(':', 1)[0].toLowerCase();
		if (scheme === 'vmess') return parseVmess(uri);
		if (scheme === 'vless') return parseVless(uri);
		if (scheme === 'trojan') return parseTrojan(uri);
		if (scheme === 'ss') return parseSS(uri);
		if (scheme === 'hysteria2' || scheme === 'hy2') return parseHysteria2(uri);
		return null;
	} catch {
		return null;
	}
}

export function encodeRecordToUri(rec: NormalizedRecord): string {
	switch (rec.type) {
		case 'vmess':
			return encodeVmess(rec);
		case 'vless':
			return encodeVless(rec);
		case 'trojan':
			return encodeTrojan(rec);
		case 'ss':
			return encodeSS(rec);
		case 'hysteria2':
			return encodeHysteria2(rec);
	}
}

// vmess 是 JSON -> Base64 的特殊格式，和其他 URI 類型不同。
function parseVmess(uri: string): NormalizedRecord | null {
	const b64 = uri.slice('vmess://'.length);
	const decoded = safeBase64Decode(b64);
	if (!decoded) return null;
	let obj: any;
	try { obj = JSON.parse(decoded); } catch { return null; }
	const server = String(obj.add || '').toLowerCase();
	const port = Number(obj.port || 0);
	const uuid = String(obj.id || '');
	if (!server || !port) return null;
	const sni = String(obj.sni || obj.host || '');
	const tls = obj.tls ? String(obj.tls).toLowerCase() === 'tls' || obj.tls === true : false;
	const name = String(obj.ps || obj.name || obj.tag || '');
	return { type: 'vmess', rawUri: uri, server, port, uuid, sni, servername: sni, tls, name, tag: name };
}

function encodeVmess(rec: NormalizedRecord): string {
	const obj: any = {
		v: '2',
		ps: rec.name || rec.tag || '',
		add: rec.server,
		port: rec.port,
		id: rec.uuid || '',
		sni: rec.sni || rec.servername || '',
		tls: rec.tls ? 'tls' : '',
		net: 'tcp',
		type: 'none',
	};
	return `vmess://${safeBase64EncodeUtf8(JSON.stringify(obj))}`;
}

function parseVless(uri: string): NormalizedRecord | null {
	const u = new URL(uri);
	const server = u.hostname.toLowerCase();
	const port = Number(u.port || 0);
	const uuid = decodeURIComponent(u.username || '');
	const sni = u.searchParams.get('sni') || u.searchParams.get('host') || '';
	const tls = u.protocol === 'vless:' && (u.searchParams.get('security') === 'tls' || u.searchParams.get('security') === 'reality' || u.searchParams.get('tls') === '1');
	const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : '';
	if (!server || !port) return null;
	return { type: 'vless', rawUri: uri, server, port, uuid, sni, servername: sni, tls, name, tag: name };
}

function encodeVless(rec: NormalizedRecord): string {
	const u = new URL('vless://example');
	u.username = rec.uuid || '';
	u.hostname = rec.server;
	u.port = String(rec.port);
	if (rec.sni || rec.servername) u.searchParams.set('sni', rec.sni || rec.servername || '');
	if (rec.tls) u.searchParams.set('security', 'tls');
	const frag = rec.name || rec.tag || '';
	return `vless://${u.username}@${u.hostname}:${u.port}${u.search}${frag ? '#' + encodeURIComponent(frag) : ''}`;
}

function parseTrojan(uri: string): NormalizedRecord | null {
	const u = new URL(uri);
	const server = u.hostname.toLowerCase();
	const port = Number(u.port || 0);
	const password = decodeURIComponent(u.username || '');
	const sni = u.searchParams.get('sni') || u.searchParams.get('host') || '';
	const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : '';
	if (!server || !port) return null;
	return { type: 'trojan', rawUri: uri, server, port, password, sni, servername: sni, tls: true, name, tag: name };
}

function encodeTrojan(rec: NormalizedRecord): string {
	const q = new URLSearchParams();
	if (rec.sni || rec.servername) q.set('sni', rec.sni || rec.servername || '');
	const frag = rec.name || rec.tag || '';
	return `trojan://${encodeURIComponent(rec.password || '')}@${rec.server}:${rec.port}${q.toString() ? '?' + q.toString() : ''}${frag ? '#' + encodeURIComponent(frag) : ''}`;
}

// ss 歷史格式很多，這裡同時兼容常見的 plain/base64 幾種寫法。
function parseSS(uri: string): NormalizedRecord | null {
	const raw = uri.slice('ss://'.length);
	let creds = '';
	let hostport = '';
	let name = '';
	const hashIdx = raw.indexOf('#');
	if (hashIdx >= 0) {
		name = decodeURIComponent(raw.slice(hashIdx + 1));
	}
	const main = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
	if (main.includes('@')) {
		const [left, right] = main.split('@');
		creds = left;
		hostport = right;
	} else {
		const decoded = safeBase64Decode(main) || '';
		if (decoded.includes('@')) {
			const [left, right] = decoded.split('@');
			creds = left;
			hostport = right;
		} else {
			creds = decoded;
		}
	}
	if (!hostport && main.includes('@')) {
		const decCreds = safeBase64Decode(creds);
		if (decCreds) creds = decCreds;
	}
	let method = '';
	let password = '';
	if (creds) {
		const dec = safeBase64Decode(creds);
		const s = dec || creds;
		const i = s.indexOf(':');
		if (i >= 0) {
			method = s.slice(0, i);
			password = s.slice(i + 1);
		}
	}
	let server = '';
	let port = 0;
	if (hostport) {
		const hp = hostport.split('?', 1)[0];
		const m = hp.match(/^\[?([^\]]+)\]?:([0-9]+)$/);
		if (m) {
			server = m[1].toLowerCase();
			port = Number(m[2]);
		}
	}
	if (!server || !port) return null;
	return { type: 'ss', rawUri: uri, server, port, method, password, name, tag: name };
}

function encodeSS(rec: NormalizedRecord): string {
	const frag = rec.name || rec.tag || '';
	if (rec.method) {
		const creds = `${rec.method}:${rec.password ?? ''}`;
		return `ss://${safeBase64EncodeUtf8(creds)}@${rec.server}:${rec.port}${frag ? '#' + encodeURIComponent(frag) : ''}`;
	}
	return `ss://${rec.server}:${rec.port}${frag ? '#' + encodeURIComponent(frag) : ''}`;
}

function parseHysteria2(uri: string): NormalizedRecord | null {
	const normalized = uri.replace(/^hy2:\/\//, 'hysteria2://');
	const u = new URL(normalized);
	const server = u.hostname.toLowerCase();
	const port = Number(u.port || 0);
	const password = decodeURIComponent(u.username || '');
	if (!server || !port || !password) return null;

	const sni = u.searchParams.get('sni') || '';
	const obfs = u.searchParams.get('obfs') || undefined;
	const obfsPassword = u.searchParams.get('obfs-password') || undefined;
	const insecure = u.searchParams.get('insecure') === '1';
	const pinSHA256 = u.searchParams.get('pinSHA256') || undefined;
	const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : '';

	return {
		type: 'hysteria2',
		rawUri: uri,
		server,
		port,
		password,
		sni,
		servername: sni,
		obfs,
		obfsPassword,
		insecure,
		pinSHA256,
		name,
		tag: name,
	};
}

function encodeHysteria2(rec: NormalizedRecord): string {
	const q = new URLSearchParams();
	if (rec.sni || rec.servername) q.set('sni', rec.sni || rec.servername || '');
	if (rec.obfs) q.set('obfs', rec.obfs);
	if (rec.obfsPassword) q.set('obfs-password', rec.obfsPassword);
	if (rec.insecure) q.set('insecure', '1');
	if (rec.pinSHA256) q.set('pinSHA256', rec.pinSHA256);
	const frag = rec.name || rec.tag || '';
	return `hysteria2://${encodeURIComponent(rec.password || '')}@${rec.server}:${rec.port}${q.toString() ? '?' + q.toString() : ''}${frag ? '#' + encodeURIComponent(frag) : ''}`;
}
