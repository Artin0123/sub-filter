import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { adminBearer } from './helpers';

const addSource = async (url: string, bearer: string) =>
	SELF.fetch('https://example.com/add', {
		method: 'POST',
		headers: { Authorization: `Bearer ${bearer}` },
		body: new URLSearchParams({ url }),
	});

describe('Source URL guard', () => {
	it('rejects overlong /add inputs with a reason', async () => {
		await env.KV_NAMESPACE.put('sources', JSON.stringify([]));
		const bearer = await adminBearer();

		const res = await addSource('x'.repeat(4097), bearer);

		expect(res.status).toBe(400);
		const json = (await res.json()) as any;
		expect(json.error).toBe('input_too_long');
		expect(String(json.message)).toContain('too long');

		const sources = await env.KV_NAMESPACE.get('sources');
		expect(sources).toBe(JSON.stringify([]));
	});

	it('rejects unsupported source schemes before they reach fetch()', async () => {
		await env.KV_NAMESPACE.put('sources', JSON.stringify([]));
		const bearer = await adminBearer();

		for (const url of ['ftp://example.com/list', 'javascript:alert(1)', 'file:///etc/passwd', 'example.com/sub']) {
			const res = await addSource(url, bearer);
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).error).toBe('unsupported_source');
		}

		const ok = await addSource('https://example.com/sub.txt', bearer);
		expect(ok.status).toBe(200);
	});

	it('rejects http(s) sources that point at private or reserved addresses', async () => {
		await env.KV_NAMESPACE.put('sources', JSON.stringify([]));
		const bearer = await adminBearer();

		const blocked = [
			'http://localhost:8080/sub',
			'http://127.0.0.1/sub',
			'http://2130706433/sub',
			'http://0x7f.0.0.1/sub',
			'http://10.1.2.3/sub',
			'http://172.16.5.4/sub',
			'http://192.168.1.5/sub',
			'http://169.254.169.254/latest/meta-data/',
			'http://[::1]/sub',
			'http://[fd00::1]/sub',
			'http://something.internal/sub',
		];

		for (const url of blocked) {
			const res = await addSource(url, bearer);
			expect(res.status, url).toBe(400);
			expect(((await res.json()) as any).error, url).toBe('blocked_source');
		}

		expect(await env.KV_NAMESPACE.get('sources')).toBe(JSON.stringify([]));
	});
});
