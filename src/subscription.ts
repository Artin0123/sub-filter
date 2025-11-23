// Subscription parsing skeleton. Full implementation will follow in step 2.

export type NormalizedRecord = {
    type: 'vmess' | 'vless' | 'trojan' | 'ss' | 'hysteria2';
    server: string;
    port: number;
    servername?: string;
    sni?: string;
    password?: string;
    method?: string; // for shadowsocks
    uuid?: string;
    tls?: boolean;
    reality?: boolean;
    name?: string;
    tag?: string;
    // hysteria2 specific
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
    // Encode a JS string as UTF-8 bytes, then to Base64 safely.
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
    // Only attempt decode if text looks like Base64 (no protocol prefix)
    // This avoids unnecessary decode attempts on plain text subscriptions
    if (/:\/\//.test(text)) {
        // Already contains protocol, not Base64 encoded
        return text;
    }

    const decoded = safeBase64Decode(text);
    // Check if decoded content contains valid proxy protocols
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

// -------- vmess --------
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
    return { type: 'vmess', server, port, uuid, sni, servername: sni, tls, name, tag: name };
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
    const json = JSON.stringify(obj);
    const b64 = safeBase64EncodeUtf8(json);
    return `vmess://${b64}`;
}

// -------- vless --------
function parseVless(uri: string): NormalizedRecord | null {
    const u = new URL(uri);
    const server = u.hostname.toLowerCase();
    const port = Number(u.port || 0);
    const uuid = decodeURIComponent(u.username || '');
    const sni = u.searchParams.get('sni') || u.searchParams.get('host') || '';
    const tls = (u.protocol === 'vless:') && (u.searchParams.get('security') === 'tls' || u.searchParams.get('security') === 'reality' || u.searchParams.get('tls') === '1');
    const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : '';
    if (!server || !port) return null;
    return { type: 'vless', server, port, uuid, sni, servername: sni, tls, name, tag: name };
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

// -------- trojan --------
function parseTrojan(uri: string): NormalizedRecord | null {
    const u = new URL(uri);
    const server = u.hostname.toLowerCase();
    const port = Number(u.port || 0);
    const password = decodeURIComponent(u.username || '');
    const sni = u.searchParams.get('sni') || u.searchParams.get('host') || '';
    const tls = true; // trojan implies TLS
    const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : '';
    if (!server || !port) return null;
    return { type: 'trojan', server, port, password, sni, servername: sni, tls, name, tag: name };
}

function encodeTrojan(rec: NormalizedRecord): string {
    const q = new URLSearchParams();
    if (rec.sni || rec.servername) q.set('sni', rec.sni || rec.servername || '');
    const frag = rec.name || rec.tag || '';
    return `trojan://${encodeURIComponent(rec.password || '')}@${rec.server}:${rec.port}${q.toString() ? '?' + q.toString() : ''}${frag ? '#' + encodeURIComponent(frag) : ''}`;
}

// -------- shadowsocks (ss) --------
function parseSS(uri: string): NormalizedRecord | null {
    // Support forms:
    // 1) ss://method:password@host:port#tag
    // 2) ss://base64("method:password")@host:port#tag
    // 3) ss://base64("method:password@host:port")#tag
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
        // Entire main is base64 of creds@host:port or creds
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
        // if creds was base64
        const decCreds = safeBase64Decode(creds);
        if (decCreds) creds = decCreds;
    }
    // creds: method:password
    let method = '';
    let password = '';
    if (creds) {
        const dec = safeBase64Decode(creds);
        const s = dec || creds; // may already be plain
        const i = s.indexOf(':');
        if (i >= 0) { method = s.slice(0, i); password = s.slice(i + 1); }
    }
    let server = '';
    let port = 0;
    if (hostport) {
        // Strip any query params like ?plugin=...
        const hp = hostport.split('?', 1)[0];
        const m = hp.match(/^\[?([^\]]+)\]?:([0-9]+)$/); // ipv6 in [] or hostname
        if (m) { server = m[1].toLowerCase(); port = Number(m[2]); }
    }
    if (!server || !port) return null;
    return { type: 'ss', server, port, method, password, name, tag: name };
}

function encodeSS(rec: NormalizedRecord): string {
    const frag = rec.name || rec.tag || '';
    if (rec.method) {
        const creds = `${rec.method}:${rec.password ?? ''}`;
        const b64 = safeBase64EncodeUtf8(creds);
        return `ss://${b64}@${rec.server}:${rec.port}${frag ? '#' + encodeURIComponent(frag) : ''}`;
    }
    // Fallback: no method known; emit minimal host:port with tag (may be ignored by clients, but avoids invalid placeholder)
    return `ss://${rec.server}:${rec.port}${frag ? '#' + encodeURIComponent(frag) : ''}`;
}

// -------- hysteria2 --------
function parseHysteria2(uri: string): NormalizedRecord | null {
    // Format: hysteria2://password@host:port?obfs=...&obfs-password=...&sni=...&insecure=1#tag
    // Also accept hy2:// as alias
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
