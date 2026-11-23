import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { adminBearer, adminCookie, inlineSource, subscriptionToken, vlessLine } from './helpers';

const bearerHeaders = async () => ({ Authorization: `Bearer ${await adminBearer()}` });

async function seedAndRefresh(lineCount: number): Promise<void> {
	const lines = Array.from({ length: lineCount }, (_, i) => vlessLine(i)).join('\n');
	await env.KV_NAMESPACE.put('sources', JSON.stringify([inlineSource(lines)]));
	await env.KV_NAMESPACE.put('chunk_size', '400');
	await env.KV_NAMESPACE.put('base64_encode', '0');
	await env.KV_NAMESPACE.delete('refresh_started_at');
	const res = await SELF.fetch('https://example.com/refresh', { method: 'POST', headers: await bearerHeaders() });
	expect(res.status).toBe(200);
}

describe('route guardrails', () => {
	it('rejects methods that are not part of the contract', async () => {
		// 寫入操作只接受 POST，訂閱以外的讀取只接受 GET。
		expect((await SELF.fetch('https://example.com/refresh')).status).toBe(405);
		expect((await SELF.fetch('https://example.com/logout')).status).toBe(405);
		expect((await SELF.fetch('https://example.com/login')).status).toBe(405);
		expect((await SELF.fetch('https://example.com/add')).status).toBe(405);
		expect((await SELF.fetch('https://example.com/remove')).status).toBe(405);
		expect((await SELF.fetch('https://example.com/list', { method: 'POST' })).status).toBe(405);
		expect((await SELF.fetch('https://example.com/debug', { method: 'DELETE' })).status).toBe(405);
	});

	it('answers 401 instead of 500 for a malformed session cookie', async () => {
		const res = await SELF.fetch('https://example.com/list', { headers: { cookie: 'session=%E0%A4%A' } });
		expect(res.status).toBe(401);

		const root = await SELF.fetch('https://example.com/', { redirect: 'manual', headers: { cookie: 'session=%E0%A4%A' } });
		expect(root.status).toBe(302);
	});

	it('lets a freshly logged-in cookie reach the admin API', async () => {
		const cookie = await adminCookie();
		const res = await SELF.fetch('https://example.com/list', { headers: { cookie } });
		expect(res.status).toBe(200);
		expect(Array.isArray(await res.json())).toBe(true);
	});

	it('rate limits repeated login attempts from one IP', async () => {
		const attempt = () =>
			SELF.fetch('https://example.com/login', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.9' },
				body: new URLSearchParams({ password: 'definitely-wrong' }),
			});

		const statuses: number[] = [];
		for (let i = 0; i < 6; i++) statuses.push((await attempt()).status);

		expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
		expect(statuses[5]).toBe(429);
	});

	it('validates chunk_size at the route boundary', async () => {
		const post = async (chunkSize: string) =>
			SELF.fetch('https://example.com/config', {
				method: 'POST',
				headers: { Authorization: `Bearer ${await adminBearer()}` },
				body: new URLSearchParams({ chunk_size: chunkSize }),
			});

		expect((await post('49')).status).toBe(400);
		expect((await post('50')).status).toBe(200);
		expect((await post('2000')).status).toBe(200);
		expect((await post('2001')).status).toBe(400);
		expect((await post('abc')).status).toBe(400);
		expect((await post('400.5')).status).toBe(400);

		await env.KV_NAMESPACE.put('chunk_size', '400');
	});

	it('exposes a random subscription token and the chunk total on /config', async () => {
		await seedAndRefresh(1);
		const res = await SELF.fetch('https://example.com/config', { headers: await bearerHeaders() });
		const cfg = (await res.json()) as any;
		expect(cfg.subscription_token).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(cfg.chunks_total).toBe(1);
	});

	it('answers HEAD on subscription chunks', async () => {
		await seedAndRefresh(1);
		const token = await subscriptionToken();
		const res = await SELF.fetch(`https://example.com/sub_1?token=${token}`, { method: 'HEAD' });
		expect(res.status).toBe(200);
	});

	it('reports 409 while a refresh lock is held', async () => {
		await env.KV_NAMESPACE.put('refresh_started_at', String(Date.now()));
		const res = await SELF.fetch('https://example.com/refresh', { method: 'POST', headers: await bearerHeaders() });
		expect(res.status).toBe(409);
		expect(((await res.json()) as any).error).toBe('refresh_in_progress');
		await env.KV_NAMESPACE.delete('refresh_started_at');
	});

	it('only creates the subscription token from the admin path, and keeps it stable afterwards', async () => {
		await env.KV_NAMESPACE.delete('subscription_token');

		// 匿名請求只驗證，不會在 KV 建立 token
		const unauthorized = await SELF.fetch('https://example.com/sub_1?token=whatever');
		expect(unauthorized.status).toBe(401);
		expect(await env.KV_NAMESPACE.get('subscription_token')).toBeNull();

		// 後台讀一次設定才建立
		const cfgRes = await SELF.fetch('https://example.com/config', { headers: await bearerHeaders() });
		const token = ((await cfgRes.json()) as any).subscription_token;
		expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(await env.KV_NAMESPACE.get('subscription_token')).toBe(token);

		// 之後每次讀到的都是同一個值（沒有 TTL、沒有輪換）
		const again = await SELF.fetch('https://example.com/config', { headers: await bearerHeaders() });
		expect(((await again.json()) as any).subscription_token).toBe(token);
	});
});
