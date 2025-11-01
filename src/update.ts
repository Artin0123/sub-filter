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
    changed: { full: boolean; byChunk: number[] };
};

export async function runUpdate(env: Env): Promise<RefreshResult> {
    const sources = (await env.KV_NAMESPACE.get(KV_KEYS.sources, { type: 'json' })) as string[] | null;
    const urls = Array.isArray(sources) ? sources.filter((s) => typeof s === 'string' && s.trim().length > 0) : [];
    const chunkSizeStr = await env.KV_NAMESPACE.get(KV_KEYS.chunkSize);
    const chunkSize = chunkSizeStr ? parseInt(chunkSizeStr, 10) : 400;

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
    for (const t of texts) {
        const body = maybeDecodeBulkBase64(t);
        const lines = parseSubscriptionText(body);
        for (const line of lines) {
            const rec = parseUriToRecord(line);
            if (rec) records.push(rec);
        }
    }

    // Dedup
    const unique = dedupRecords(records);
    const encodedLines = unique.map((r) => encodeRecordToUri(r));

    // Chunking
    const chunks: string[] = [];
    for (let i = 0; i < encodedLines.length; i += chunkSize) {
        const part = encodedLines.slice(i, i + chunkSize).join('\n');
        chunks.push(part);
    }
    const newTotal = chunks.length;
    const oldTotalStr = await env.KV_NAMESPACE.get(KV_KEYS.chunksTotal);
    const oldTotal = oldTotalStr ? parseInt(oldTotalStr, 10) : 0;

    const changedChunks: number[] = [];
    for (let i = 0; i < newTotal; i++) {
        const content = chunks[i];
        const etag = await sha256Hex(content);
        const existing = await env.KV_NAMESPACE.get(KV_KEYS.etagI(i + 1));
        if (existing !== etag) {
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

    // Full output
    const full = encodedLines.join('\n');
    const fullEtag = await sha256Hex(full);
    const existingFullEtag = await env.KV_NAMESPACE.get(KV_KEYS.etag);
    let fullChanged = false;
    if (existingFullEtag !== fullEtag) {
        await env.KV_NAMESPACE.put(KV_KEYS.subTxt, full);
        await env.KV_NAMESPACE.put(KV_KEYS.etag, fullEtag);
        fullChanged = true;
    }

    await env.KV_NAMESPACE.put(KV_KEYS.lastUpdatedISO, new Date().toISOString());

    const updated = fullChanged || changedChunks.length > 0 || oldTotal !== newTotal;

    return {
        updated,
        records: unique.length,
        chunks: { total: newTotal, size: chunkSize },
        perSource: { ok, fail },
        changed: { full: fullChanged, byChunk: changedChunks },
    };
}
