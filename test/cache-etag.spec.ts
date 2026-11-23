import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { adminBearer, inlineSource, subscriptionToken } from './helpers';

const makeInline = () => [
	'vless://11111111-1111-1111-1111-111111111111@h1.test:443?sni=h1.test#v1',
	'trojan://p1@h2.test:443?sni=h2.test#t1',
	'vmess://' + btoa(JSON.stringify({ add: 'h3.test', port: 443, id: '22222222-2222-2222-2222-222222222222', sni: 'h3.test', tls: 'tls', ps: 'm1' })),
	'vless://33333333-3333-3333-3333-333333333333@h4.test:443?sni=h4.test#v2',
	'trojan://p2@h5.test:443?sni=h5.test#t2',
].join('\n');

describe('Cache/ETag flow', () => {
	it('serves quoted ETags and honours If-None-Match variants; out of range is 404', async () => {
		await env.KV_NAMESPACE.put('sources', JSON.stringify([inlineSource(makeInline())]));
		await env.KV_NAMESPACE.put('chunk_size', '2'); // ensure multiple chunks
		await env.KV_NAMESPACE.put('base64_encode', '0');

		// Trigger refresh
		const res0 = await SELF.fetch('https://example.com/refresh', {
			method: 'POST',
			headers: { Authorization: `Bearer ${await adminBearer()}` },
		});
		expect(res0.status).toBe(200);

		const token = await subscriptionToken();

		// chunk 2
		const c1 = await SELF.fetch(`https://example.com/sub_2?token=${token}`);
		expect(c1.status).toBe(200);
		const etag = c1.headers.get('etag');
		// RFC 9110 的 entity-tag 必須帶引號
		expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

		const notModified = async (value: string) => {
			const res = await SELF.fetch(`https://example.com/sub_2?token=${token}`, { headers: { 'If-None-Match': value } });
			return res.status;
		};
		expect(await notModified(etag!)).toBe(304);
		expect(await notModified('*')).toBe(304);
		// RFC 9110：weak validator 寫成 W/"opaque"
		expect(await notModified(`W/${etag!}`)).toBe(304);
		// opaque tag 可以含逗號，所以必須在原始字串上比對，不能先 split(',')
		expect(await notModified(`"deadbeef", W/${etag!}, "cafe"`)).toBe(304);
		// 不能因為「包含相同 hex」就誤判：完整的 tag 必須相符
		expect(await notModified(`"${etag!.slice(1, -1)}ff"`)).toBe(200);
		expect(await notModified('"0000000000000000000000000000000000000000000000000000000000000000"')).toBe(200);

		// out of range (get chunks_total from KV)
		const totalStr = await env.KV_NAMESPACE.get('chunks_total');
		const total = totalStr ? parseInt(totalStr, 10) : 0;
		const out = await SELF.fetch(`https://example.com/sub_${total + 1}?token=${token}`);
		expect(out.status).toBe(404);

		// token 驗證
		expect((await SELF.fetch(`https://example.com/sub_1?token=wrong`)).status).toBe(401);
		expect((await SELF.fetch('https://example.com/sub_1')).status).toBe(401);
	});
});
