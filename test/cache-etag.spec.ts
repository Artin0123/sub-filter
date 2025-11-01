import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const makeInline = () => [
    'vless://11111111-1111-1111-1111-111111111111@h1.test:443?sni=h1.test#v1',
    'trojan://p1@h2.test:443?sni=h2.test#t1',
    'vmess://' + btoa(JSON.stringify({ add: 'h3.test', port: 443, id: '22222222-2222-2222-2222-222222222222', sni: 'h3.test', tls: 'tls', ps: 'm1' })),
    'vless://33333333-3333-3333-3333-333333333333@h4.test:443?sni=h4.test#v2',
    'trojan://p2@h5.test:443?sni=h5.test#t2',
].join('\n');

describe('Cache/ETag flow', () => {
    it('returns 304 on If-None-Match for chunk endpoints; index out of range is 404', async () => {
        await env.KV_NAMESPACE.put('sources', JSON.stringify([`inline:${makeInline()}`]));
        await env.KV_NAMESPACE.put('chunk_size', '2'); // ensure multiple chunks

        // Trigger refresh
        const res0 = await SELF.fetch('https://example.com/refresh', {
            method: 'POST', headers: { Authorization: `Bearer ${env.ADMIN_PASSWORD}` },
        });
        expect(res0.status).toBe(200);

        // chunk 2
        const c1 = await SELF.fetch('https://example.com/sub_2.txt');
        expect(c1.status).toBe(200);
        const etag2 = c1.headers.get('etag');
        expect(etag2).toBeTruthy();

        // chunk 2 304
        const c2 = await SELF.fetch('https://example.com/sub_2.txt', { headers: { 'If-None-Match': etag2! } });
        expect(c2.status).toBe(304);

        // out of range (get chunks_total from KV)
        const totalStr = await env.KV_NAMESPACE.get('chunks_total');
        const total = totalStr ? parseInt(totalStr, 10) : 0;
        const out = await SELF.fetch(`https://example.com/sub_${total + 1}.txt`);
        expect(out.status).toBe(404);
    });
});
