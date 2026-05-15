import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';

async function generateBearerToken(password: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', encoder.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const payload = { sub: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 };
	const body = encoder.encode(JSON.stringify(payload));
	const sig = await crypto.subtle.sign({ name: 'HMAC' }, key, body);

	const toBase64Url = (data: ArrayBuffer | Uint8Array): string => {
		const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
		let str = '';
		for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
		return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
	};
	return `${toBase64Url(body)}.${toBase64Url(sig)}`;
}

describe('Source URL length guard', () => {
	it('rejects overlong /add inputs with a reason', async () => {
		await env.KV_NAMESPACE.put('sources', JSON.stringify([]));
		const bearerToken = await generateBearerToken(env.ADMIN_PASSWORD);

		const tooLong = 'x'.repeat(4097);
		const res = await SELF.fetch('https://example.com/add', {
			method: 'POST',
			headers: { Authorization: `Bearer ${bearerToken}` },
			body: new URLSearchParams({ url: tooLong }),
		});

		expect(res.status).toBe(400);
		const json = (await res.json()) as any;
		expect(json.error).toBe('input_too_long');
		expect(String(json.message)).toContain('长');

		const sources = await env.KV_NAMESPACE.get('sources');
		expect(sources).toBe(JSON.stringify([]));
	});
});

