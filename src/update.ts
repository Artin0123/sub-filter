import { fetchWithRetry } from './fetchers';
import { KV_KEYS } from './kv';
import { sha256Hex } from './hash';
import { dedupRecords } from './dedup';
import { maybeDecodeBulkBase64, parseSubscriptionText, parseUriToRecord, encodeRecordToUri, type NormalizedRecord } from './subscription';

export type RefreshResult = {
    updated: boolean;
    records: number;
    chunks: { total: number; size: number };
    perSource: { ok: number; fail: number };
    changed: { byChunk: number[] };
    debug?: {
        linesTotal: number;
        parsedByScheme: Record<string, number>;
        failedByScheme: Record<string, number>;
        duplicates: number;
        chunkLineCounts: number[];
    };
};

export async function runUpdate(env: Env): Promise<RefreshResult> {
    const sources = (await env.KV_NAMESPACE.get(KV_KEYS.sources, { type: 'json' })) as string[] | null;
    const urls = Array.isArray(sources) ? sources.filter((s) => typeof s === 'string' && s.trim().length > 0) : [];
    const chunkSizeStr = await env.KV_NAMESPACE.get(KV_KEYS.chunkSize);
    const chunkSize = chunkSizeStr ? parseInt(chunkSizeStr, 10) : 400;
    const base64EncodeStr = await env.KV_NAMESPACE.get(KV_KEYS.base64Encode);
    const shouldBase64Encode = base64EncodeStr === '1';

    // Check if base64 setting changed (to force update all chunks)
    const lastBase64Setting = await env.KV_NAMESPACE.get('last_base64_setting');
    const base64SettingChanged = lastBase64Setting !== base64EncodeStr;
    if (base64SettingChanged) {
        await env.KV_NAMESPACE.put('last_base64_setting', base64EncodeStr || '0');
    }



    let ok = 0, fail = 0;
    const texts: string[] = [];

    // Controlled concurrency (size 5)
    const concurrency = 5;
    for (let i = 0; i < urls.length; i += concurrency) {
        const batch = urls.slice(i, i + concurrency);
        const results = await Promise.all(batch.map(async (u) => {
            if (u.startsWith('inline:')) {
                return { url: u, ok: true, status: 200, text: u.slice('inline:'.length) };
            }
            if (u.startsWith('data:')) {
                try {
                    const dataUrl = new URL(u);
                    const comma = u.indexOf(',');
                    const isBase64 = /;base64,/.test(u.slice(0, comma + 1));
                    const payload = u.slice(comma + 1);
                    const text = isBase64 ? atob(payload) : decodeURIComponent(payload);
                    return { url: u, ok: true, status: 200, text };
                } catch (e) {
                    return { url: u, ok: false, status: 0, error: String(e) } as const;
                }
            }
            return fetchWithRetry(u);
        }));
        for (const r of results) {
            if (r.ok && r.text) {
                ok++;
                texts.push(r.text);
            } else {
                fail++;
            }
        }
    }

    // Parse and normalize
    const records: NormalizedRecord[] = [];
    let linesTotal = 0;
    const parsedByScheme: Record<string, number> = {};
    const failedByScheme: Record<string, number> = {};
    for (const t of texts) {
        const body = maybeDecodeBulkBase64(t);
        const lines = parseSubscriptionText(body);
        linesTotal += lines.length;
        for (const line of lines) {
            const scheme = (line.split(":", 1)[0] || "").toLowerCase();
            const rec = parseUriToRecord(line);
            if (rec) records.push(rec);
            (rec ? parsedByScheme : failedByScheme)[scheme || 'unknown'] = ((rec ? parsedByScheme : failedByScheme)[scheme || 'unknown'] || 0) + 1;
        }
    }

    // Dedup
    const unique = dedupRecords(records);
    const encodedLines = unique.map((r) => encodeRecordToUri(r));

    // Chunking
    const chunks: string[] = [];
    const chunkLineCounts: number[] = [];
    for (let i = 0; i < encodedLines.length; i += chunkSize) {
        const slice = encodedLines.slice(i, i + chunkSize);
        let part = slice.join('\n');

        // Base64 encode if enabled
        if (shouldBase64Encode) {
            const encoder = new TextEncoder();
            const bytes = encoder.encode(part);
            let binary = '';
            for (let j = 0; j < bytes.length; j++) {
                binary += String.fromCharCode(bytes[j]);
            }
            part = btoa(binary);
        }

        chunks.push(part);
        chunkLineCounts.push(slice.length);
    }
    const newTotal = chunks.length;
    const oldTotalStr = await env.KV_NAMESPACE.get(KV_KEYS.chunksTotal);
    const oldTotal = oldTotalStr ? parseInt(oldTotalStr, 10) : 0;

    const changedChunks: number[] = [];
    for (let i = 0; i < newTotal; i++) {
        const content = chunks[i];
        const etag = await sha256Hex(content);
        const existing = await env.KV_NAMESPACE.get(KV_KEYS.etagI(i + 1));
        // Force update if base64 setting changed or etag changed
        if (base64SettingChanged || existing !== etag) {
            await env.KV_NAMESPACE.put(KV_KEYS.subTxtI(i + 1), content);
            await env.KV_NAMESPACE.put(KV_KEYS.etagI(i + 1), etag);
            changedChunks.push(i + 1);
        }
    }

    // Delete extra old chunks
    if (oldTotal > newTotal) {
        for (let j = newTotal + 1; j <= oldTotal; j++) {
            await env.KV_NAMESPACE.delete(KV_KEYS.subTxtI(j));
            await env.KV_NAMESPACE.delete(KV_KEYS.etagI(j));
        }
    }

    // Update total
    await env.KV_NAMESPACE.put(KV_KEYS.chunksTotal, String(newTotal));

    await env.KV_NAMESPACE.put(KV_KEYS.lastUpdatedISO, new Date().toISOString());
    const duplicates = records.length - unique.length;
    const debugInfo = { linesTotal, parsedByScheme, failedByScheme, duplicates, chunkLineCounts };
    await env.KV_NAMESPACE.put(KV_KEYS.lastStats, JSON.stringify(debugInfo));

    const updated = changedChunks.length > 0 || oldTotal !== newTotal;

    // Purge edge cache for all chunks if content changed
    if (updated) {
        console.log('Purging edge cache for', newTotal, 'chunks');
        // Note: Cloudflare edge cache will be purged by ETag mismatch on next request
        // The cache uses request URL as key, so new ETag will cause cache miss
    }

    return {
        updated,
        records: unique.length,
        chunks: { total: newTotal, size: chunkSize },
        perSource: { ok, fail },
        changed: { byChunk: changedChunks },
        debug: debugInfo,
    };
}
