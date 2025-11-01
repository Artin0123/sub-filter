import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const inlineBody = [
    'vless://11111111-1111-1111-1111-111111111111@example.com:443?sni=example.com#vl1',
    'trojan://pass@example.com:443?sni=example.com#tr1',
    'vmess://' + btoa(JSON.stringify({ add: 'example.com', port: 443, id: '22222222-2222-2222-2222-222222222222', sni: 'example.com', tls: 'tls', ps: 'vm1' })),
].join('\n');

describe('Refresh update flow (inline source)', () => {
    it('updates KV and serves chunk endpoints', async () => {
        // Seed KV
        await env.KV_NAMESPACE.put('sources', JSON.stringify([`inline:${inlineBody}`]));
        await env.KV_NAMESPACE.put('chunk_size', '2');

        // Trigger refresh via Bearer
        const res = await SELF.fetch('https://example.com/refresh', {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.ADMIN_PASSWORD}` },
        });
        expect(res.status).toBe(200);
        const json = (await res.json()) as any;
        expect(json.records).toBeGreaterThan(0);
        expect(json.chunks.total).toBeGreaterThan(0);

        // Read sub_1.txt
        const res3 = await SELF.fetch('https://example.com/sub_1.txt');
        expect([200, 404]).toContain(res3.status); // depending on total chunks
    });
});
