// Deduplication helpers
import type { NormalizedRecord } from './subscription';

// Removed unused dedupLines; record-level deduplication is the canonical path.

export function dedupRecords(records: NormalizedRecord[]): NormalizedRecord[] {
    const seen = new Set<string>();
    const out: NormalizedRecord[] = [];
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
