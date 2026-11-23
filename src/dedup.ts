// Deduplication helpers
import type { NormalizedRecord } from './subscription';

// Removed unused dedupLines; record-level deduplication is the canonical path.

export function dedupRecords(records: NormalizedRecord[]): NormalizedRecord[] {
    const seen = new Set<string>();
    const out: NormalizedRecord[] = [];
    for (const r of records) {
        const server = (r.server || '').trim().toLowerCase();
        const port = r.port | 0;
        if (!server || port <= 0 || port > 65535) continue;
        const type = r.type || '';
        const method = r.method || '';
        const id = r.password || r.uuid || '';
        const sni = (r.servername || r.sni || '').trim().toLowerCase();
        const key = `${type}:${server}:${port}:${sni}:${method}:${id}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(r);
        }
    }
    return out;
}
