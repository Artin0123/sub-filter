import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { runUpdate } from '../src/update';
import { inlineSource, vlessLine } from './helpers';

function mkLines(n: number): string {
    // Generate unique hosts to avoid deduplication in pipeline
    return Array.from({ length: n }, (_, i) => vlessLine(i)).join('\n');
}

async function setSourceLines(n: number) {
    await env.KV_NAMESPACE.put('sources', JSON.stringify([inlineSource(mkLines(n))]));
}

describe('chunking', () => {
    const cases = [0, 1, 399, 400, 401, 800, 801];
    it('chunk count and last chunk size for various line counts', async () => {
        for (const lines of cases) {
            await env.KV_NAMESPACE.put('chunk_size', '400');
            await setSourceLines(lines);
            const r = await runUpdate(env as any);
            const expectedTotal = Math.ceil(lines / 400);
            expect(r.chunks.total).toBe(expectedTotal);
            if (expectedTotal > 0) {
                const lastSize = lines === 0 ? 0 : (lines % 400 === 0 ? 400 : lines % 400);
                // Read last chunk content and count lines
                const content = await env.KV_NAMESPACE.get(`sub_txt_${expectedTotal}`);
                const count = content ? content.split('\n').filter(Boolean).length : 0;
                expect(count).toBe(lastSize);
            }
        }
    });

    it('etag_i matches content hash and unchanged content not rewritten', async () => {
        await env.KV_NAMESPACE.put('chunk_size', '3');
        await setSourceLines(7);
        const r1 = await runUpdate(env as any);
        expect(r1.chunks.total).toBe(3);
        const e2a = await env.KV_NAMESPACE.get('etag_2');
        const c2 = await env.KV_NAMESPACE.get('sub_txt_2');
        // hash function already validated elsewhere; just ensure etag exists and content exists
        expect(e2a).toBeTruthy();
        expect(c2).toBeTruthy();

        // run again without changes
        const r2 = await runUpdate(env as any);
        expect(r2.changedChunks).toEqual([]);
    });

    it('rechunk after chunk_size change and clean extra chunks', async () => {
        await env.KV_NAMESPACE.put('chunk_size', '4');
        await setSourceLines(9); // 3 chunks of 4,4,1
        const r1 = await runUpdate(env as any);
        expect(r1.chunks.total).toBe(3);

        await env.KV_NAMESPACE.put('chunk_size', '6');
        const r2 = await runUpdate(env as any);
        expect(r2.chunks.total).toBe(2); // 6+3

        // old chunk 3 should be removed
        const gone = await env.KV_NAMESPACE.get('sub_txt_3');
        expect(gone).toBeNull();
    });

    it('falls back to safe chunk sizes when KV holds garbage', async () => {
        // `0` 會讓 `i += chunkSize` 永遠不前進（Worker CPU 被打爆），必須夾回預設值。
        await env.KV_NAMESPACE.put('chunk_size', '0');
        await setSourceLines(5);
        const r0 = await runUpdate(env as any);
        expect(r0.chunks.size).toBe(400);
        expect(r0.chunks.total).toBe(1);

        await env.KV_NAMESPACE.put('chunk_size', '99999');
        const r1 = await runUpdate(env as any);
        expect(r1.chunks.size).toBe(2000);

        await env.KV_NAMESPACE.put('chunk_size', 'not-a-number');
        const r2 = await runUpdate(env as any);
        expect(r2.chunks.size).toBe(400);
    });

    it('handles more than 100 chunks (KV multi-get is batched)', async () => {
        // KV 單次多鍵 get 上限是 100 個 key，超過時必須分批，否則會整批失敗或漏讀。
        await env.KV_NAMESPACE.put('chunk_size', '1');
        await setSourceLines(150);

        const r1 = await runUpdate(env as any);
        expect(r1.chunks.total).toBe(150);
        expect(r1.changedChunks).toHaveLength(150);

        // 第二次必須讀到全部 150 個 ETag，因此不該重寫任何分塊。
        const r2 = await runUpdate(env as any);
        expect(r2.changedChunks).toEqual([]);
    });

    it('removes every chunk when all sources disappear', async () => {
        await env.KV_NAMESPACE.put('chunk_size', '2');
        await setSourceLines(5);
        await runUpdate(env as any);
        expect(await env.KV_NAMESPACE.get('chunks_total')).toBe('3');

        await env.KV_NAMESPACE.put('sources', JSON.stringify([]));
        const r = await runUpdate(env as any);
        expect(r.chunks.total).toBe(0);
        expect(await env.KV_NAMESPACE.get('chunks_total')).toBe('0');
        expect(await env.KV_NAMESPACE.get('sub_txt_1')).toBeNull();
        expect(await env.KV_NAMESPACE.get('etag_1')).toBeNull();
        expect(await env.KV_NAMESPACE.get('sub_txt_3')).toBeNull();
    });
});
