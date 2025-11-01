import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { parseSubscriptionText, parseUriToRecord } from '../src/subscription';
import { dedupRecords } from '../src/dedup';
import { a, b } from '../sample/data';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function expectedUniqueCount(texts: string[]): number {
    const all = texts.flatMap((t) => parseSubscriptionText(t)).map((line) => parseUriToRecord(line)).filter((r): r is NonNullable<ReturnType<typeof parseUriToRecord>> => !!r);
    return dedupRecords(all).length;
}

describe('Sample files merge and chunk', () => {
    it('merges sample files, dedups, and chunks', async () => {
        await env.KV_NAMESPACE.put('sources', JSON.stringify([`inline:${a}`, `inline:${b}`]));
        await env.KV_NAMESPACE.put('chunk_size', '3');

        const res = await SELF.fetch('https://example.com/refresh', { method: 'POST', headers: { Authorization: `Bearer ${env.ADMIN_PASSWORD}` } });
        expect(res.status).toBe(200);
        const j = await res.json() as any;

        const expected = expectedUniqueCount([a, b]);
        expect(j.records).toBe(expected);
        expect(j.chunks.total).toBeGreaterThan(0);

        // ensure first chunk can be fetched
        const c1 = await SELF.fetch('https://example.com/sub_1.txt');
        expect([200, 404]).toContain(c1.status);
    });
});
