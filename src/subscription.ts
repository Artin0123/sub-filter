// Subscription parsing skeleton. Full implementation will follow in step 2.

export type NormalizedRecord = {
    type: 'vmess' | 'vless' | 'trojan' | 'ss';
    server: string;
    port: number;
    servername?: string;
    sni?: string;
    password?: string;
    uuid?: string;
    tls?: boolean;
    reality?: boolean;
    name?: string;
    tag?: string;
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

export function parseSubscriptionText(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
}

export function maybeDecodeBulkBase64(text: string): string {
    const decoded = safeBase64Decode(text);
    if (decoded && /:\/\//.test(decoded)) return decoded;
    return text;
}

export function parseUriToRecord(uri: string): NormalizedRecord | null {
    try {
        const scheme = uri.split(':', 1)[0].toLowerCase();
        if (scheme === 'vmess') return parseVmess(uri);
        if (scheme === 'vless') return parseVless(uri);
        if (scheme === 'trojan') return parseTrojan(uri);
        if (scheme === 'ss') return parseSS(uri);
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
    const b64 = btoa(json);
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
        const m = hostport.match(/^\[?([^\]]+)\]?:([0-9]+)$/); // ipv6 in [] or hostname
        if (m) { server = m[1].toLowerCase(); port = Number(m[2]); }
    }
    if (!server || !port) return null;
    return { type: 'ss', server, port, password, name, tag: name };
}

function encodeSS(rec: NormalizedRecord): string {
    const creds = `${rec.password ? `:${rec.password}` : ''}`; // method omitted (unknown), keep password only if present
    // Prefer simpler: method not known; emit base minimal form without method if absent
    // If password present but no method, we still cannot form a valid SS URI. Fallback to plain host:port as tag-only is invalid.
    // Emit without credentials if missing.
    const userinfo = rec.password ? `:${encodeURIComponent(rec.password)}` : '';
    const base = `ss://${userinfo ? 'method' + userinfo + '@' : ''}${rec.server}:${rec.port}`; // put placeholder method when password exists
    const frag = rec.name || rec.tag || '';
    return `${base}${frag ? '#' + encodeURIComponent(frag) : ''}`;
}
