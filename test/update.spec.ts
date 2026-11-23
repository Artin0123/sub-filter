import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { adminBearer, inlineSource, subscriptionToken } from './helpers';

const vmessRaw = 'vmess://' + btoa(JSON.stringify({
    add: 'example.com',
    port: 443,
    id: '22222222-2222-2222-2222-222222222222',
    sni: 'example.com',
    host: 'cdn.example.com',
    path: '/ws',
    net: 'ws',
    tls: 'tls',
    ps: 'vm1',
}));

const inlineBody = [
    'vless://11111111-1111-1111-1111-111111111111@example.com:443?security=reality&sni=example.com&pbk=test-key&sid=abcd&fp=chrome&type=tcp#vl1',
    'trojan://pass@example.com:443?sni=example.com#tr1',
    vmessRaw,
].join('\n');

async function refresh(): Promise<any> {
    const res = await SELF.fetch('https://example.com/refresh', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await adminBearer()}` },
    });
    expect(res.status).toBe(200);
    return res.json();
}

describe('Refresh update flow (inline source)', () => {
    it('updates KV and serves chunk endpoints', async () => {
        // Seed KV
        await env.KV_NAMESPACE.put('sources', JSON.stringify([inlineSource(inlineBody)]));
        await env.KV_NAMESPACE.put('chunk_size', '2');
        await env.KV_NAMESPACE.put('base64_encode', '0');

        const json = await refresh();
        expect(json.records).toBeGreaterThan(0);
        expect(json.chunks.total).toBeGreaterThan(0);
        expect(json.failedSources).toEqual([]);

        const token = await subscriptionToken();

        // Read sub_1 with token
        const res3 = await SELF.fetch(`https://example.com/sub_1?token=${token}`);
        expect(res3.status).toBe(200); // should exist after refresh
        const text = await res3.text();
        expect(text).toContain('security=reality');
        expect(text).toContain('pbk=test-key');

        // Read sub_2 with token (chunk_size=2 puts the 3rd record in sub_2)
        const res4 = await SELF.fetch(`https://example.com/sub_2?token=${token}`);
        expect(res4.status).toBe(200);
        const text2 = await res4.text();
        expect(text2).toContain(vmessRaw);
    });

    it('counts an empty but successful source as ok', async () => {
        await env.KV_NAMESPACE.put('sources', JSON.stringify([inlineSource('')]));
        await env.KV_NAMESPACE.put('chunk_size', '400');

        const json = await refresh();
        expect(json.perSource).toEqual({ ok: 1, fail: 0 });
        expect(json.failedSources).toEqual([]);
        expect(json.records).toBe(0);
        expect(json.chunks.total).toBe(0);
    });

    it('reports why a source failed instead of only counting it', async () => {
        await env.KV_NAMESPACE.put('sources', JSON.stringify(['ftp://example.com/sub', inlineSource(inlineBody)]));

        const json = await refresh();
        expect(json.perSource).toEqual({ ok: 1, fail: 1 });
        expect(json.failedSources).toEqual([{ url: 'ftp://example.com/sub', error: 'unsupported_scheme' }]);
        expect(json.records).toBeGreaterThan(0);
    });
});
