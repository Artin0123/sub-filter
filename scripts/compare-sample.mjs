import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Lightweight re-implementations to avoid importing TS modules
function parseSubscriptionText(text) {
    return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
}

function safeBase64Decode(input) {
    try {
        const pad = input.length % 4 === 2 ? '==' : input.length % 4 === 1 ? '===' : input.length % 4 === 3 ? '=' : '';
        const s = Buffer.from(input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
        return s;
    } catch {
        return null;
    }
}

function maybeDecodeBulkBase64(text) {
    const decoded = safeBase64Decode(text);
    if (decoded && /:\/\//.test(decoded)) return decoded;
    return text;
}

function parseUriToRecord(uri) {
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

function parseVmess(uri) {
    const b64 = uri.slice('vmess://'.length);
    const decoded = safeBase64Decode(b64);
    if (!decoded) return null;
    let obj;
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

function parseVless(uri) {
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

function parseTrojan(uri) {
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

function parseSS(uri) {
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
        if (i >= 0) { method = s.slice(0, i); password = s.slice(i + 1); }
    }
    let server = '';
    let port = 0;
    if (hostport) {
        const hp = hostport.split('?', 1)[0];
        const m = hp.match(/^\[?([^\]]+)\]?:([0-9]+)$/);
        if (m) { server = m[1].toLowerCase(); port = Number(m[2]); }
    }
    if (!server || !port) return null;
    return { type: 'ss', server, port, method, password, name, tag: name };
}

function encodeRecordToUri(rec) {
    switch (rec.type) {
        case 'vmess': return encodeVmess(rec);
        case 'vless': return encodeVless(rec);
        case 'trojan': return encodeTrojan(rec);
        case 'ss': return encodeSS(rec);
    }
}

function safeBase64EncodeUtf8(input) {
    return Buffer.from(input, 'utf8').toString('base64');
}

function encodeVmess(rec) {
    const obj = {
        v: '2', ps: rec.name || rec.tag || '', add: rec.server, port: rec.port,
        id: rec.uuid || '', sni: rec.sni || rec.servername || '', tls: rec.tls ? 'tls' : '', net: 'tcp', type: 'none'
    };
    const json = JSON.stringify(obj);
    const b64 = safeBase64EncodeUtf8(json);
    return `vmess://${b64}`;
}

function encodeVless(rec) {
    const u = new URL('vless://example');
    u.username = rec.uuid || '';
    u.hostname = rec.server;
    u.port = String(rec.port);
    if (rec.sni || rec.servername) u.searchParams.set('sni', rec.sni || rec.servername || '');
    if (rec.tls) u.searchParams.set('security', 'tls');
    const frag = rec.name || rec.tag || '';
    return `vless://${u.username}@${u.hostname}:${u.port}${u.search}${frag ? '#' + encodeURIComponent(frag) : ''}`;
}

function encodeTrojan(rec) {
    const q = new URLSearchParams();
    if (rec.sni || rec.servername) q.set('sni', rec.sni || rec.servername || '');
    const frag = rec.name || rec.tag || '';
    return `trojan://${encodeURIComponent(rec.password || '')}@${rec.server}:${rec.port}${q.toString() ? '?' + q.toString() : ''}${frag ? '#' + encodeURIComponent(frag) : ''}`;
}

function encodeSS(rec) {
    const frag = rec.name || rec.tag || '';
    if (rec.method) {
        const creds = `${rec.method}:${rec.password ?? ''}`;
        const b64 = safeBase64EncodeUtf8(creds);
        return `ss://${b64}@${rec.server}:${rec.port}${frag ? '#' + encodeURIComponent(frag) : ''}`;
    }
    return `ss://${rec.server}:${rec.port}${frag ? '#' + encodeURIComponent(frag) : ''}`;
}

function dedupRecords(records) {
    const seen = new Set();
    const out = [];
    for (const r of records) {
        const server = (r.server || '').toLowerCase();
        const port = r.port | 0;
        if (!server || !port) continue;
        const id = r.password || r.uuid || '';
        const sni = r.servername || r.sni || '';
        const key = `${server}:${port}:${sni}:${id}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(r);
        }
    }
    return out;
}

function keyOf(rec) {
    const server = (rec.server || '').toLowerCase();
    const port = rec.port | 0;
    const sni = rec.servername || rec.sni || '';
    const id = rec.password || rec.uuid || '';
    return `${server}:${port}:${sni}:${id}`;
}

async function main() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const root = join(__dirname, '..');
    const sampleDir = join(root, 'sample');
    const convertDir = join(sampleDir, 'convert');

    const sampleFiles = ['ss.txt', 'ss_2.txt', 'vmess.txt', 'V2Nodes_config.txt'];
    const sampleTexts = [];
    for (const f of sampleFiles) {
        try {
            const txt = await fs.readFile(join(sampleDir, f), 'utf8');
            sampleTexts.push(txt);
        } catch { }
    }

    const parsed = [];
    const failed = [];
    const byScheme = {};
    for (const t of sampleTexts) {
        const body = maybeDecodeBulkBase64(t);
        const lines = parseSubscriptionText(body);
        for (const line of lines) {
            const scheme = (line.split(':', 1)[0] || '').toLowerCase();
            const rec = parseUriToRecord(line);
            if (rec) parsed.push(rec); else failed.push(line);
            byScheme[scheme] = byScheme[scheme] || { ok: 0, fail: 0 };
            byScheme[scheme][rec ? 'ok' : 'fail']++;
        }
    }

    const unique = dedupRecords(parsed);
    const encoded = unique.map(encodeRecordToUri);
    const encodedSet = new Set(encoded.map((l) => l.trim()).filter(Boolean));

    const convertFiles = ['sub_1.txt', 'sub_2.txt', 'sub_3.txt', 'sub_4.txt'];
    const convertedLines = [];
    for (const f of convertFiles) {
        try {
            const txt = await fs.readFile(join(convertDir, f), 'utf8');
            convertedLines.push(...parseSubscriptionText(txt));
        } catch { }
    }
    const convertedSet = new Set(convertedLines.map((l) => l.trim()).filter(Boolean));

    const missingInConvert = [];
    for (const l of encodedSet) if (!convertedSet.has(l)) missingInConvert.push(l);
    const extraInConvert = [];
    for (const l of convertedSet) if (!encodedSet.has(l)) extraInConvert.push(l);

    const groups = {};
    for (const r of parsed) {
        const k = keyOf(r); (groups[k] = groups[k] || []).push(r);
    }
    const duplicates = Object.entries(groups)
        .filter(([, arr]) => arr.length > 1)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 50)
        .map(([k, arr]) => ({ key: k, count: arr.length }));

    const report = {
        counts: {
            sampleFiles: sampleFiles.length,
            convertFiles: convertFiles.length,
            parsed: parsed.length,
            unique: unique.length,
            converted: convertedSet.size,
            missingInConvert: missingInConvert.length,
            extraInConvert: extraInConvert.length,
            failed: failed.length,
        },
        byScheme,
        duplicatesTop: duplicates,
        samples: {
            missingInConvert: missingInConvert.slice(0, 50),
            extraInConvert: extraInConvert.slice(0, 50),
            failed: failed.slice(0, 50),
        },
    };

    const outPath = join(sampleDir, 'diff-report.json');
    await fs.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log('Wrote', outPath);
    console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
