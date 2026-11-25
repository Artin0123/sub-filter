import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { adminBearer, inlineSource } from './helpers';

const vmess = 'vmess://' + btoa(JSON.stringify({ add: 'vm.example.com', port: 443, id: 'u1', ps: 'vm' }));
const vless = 'vless://11111111-1111-1111-1111-111111111111@vl.example.com:443?security=tls&sni=vl.example.com#vl';
const trojan = 'trojan://pass@tr.example.com:443?sni=tr.example.com#tr';
const hy2 = 'hy2://pw@hy.example.com:443?sni=hy.example.com#hy';
const body = [vmess, vless, trojan, hy2].join('\n');
const source = inlineSource(body);

async function api(path: string, init: RequestInit = {}): Promise<Response> {
	return SELF.fetch(`https://example.com${path}`, {
		...init,
		headers: { Authorization: `Bearer ${await adminBearer()}` },
	});
}

const post = (path: string, params: Record<string, string>) =>
	api(path, { method: 'POST', body: new URLSearchParams(params) });

async function refresh(): Promise<any> {
	await env.KV_NAMESPACE.delete('refresh_started_at');
	const res = await api('/refresh', { method: 'POST' });
	expect(res.status).toBe(200);
	return res.json();
}

async function refreshedLines(): Promise<string[]> {
	await refresh();
	const token = ((await (await api('/config')).json()) as any).subscription_token;
	const res = await SELF.fetch(`https://example.com/sub_1?token=${token}`);
	if (res.status === 404) return [];
	return (await res.text()).split('\n').filter(Boolean);
}

beforeEach(async () => {
	await env.KV_NAMESPACE.put('sources', JSON.stringify([source]));
	await env.KV_NAMESPACE.put('chunk_size', '400');
	await env.KV_NAMESPACE.put('base64_encode', '0');
	await env.KV_NAMESPACE.delete('source_filters');
});

describe('per-source protocol filter', () => {
	it('keeps everything when no filter is set', async () => {
		const lines = await refreshedLines();
		expect(lines).toEqual([vmess, vless, trojan, hy2]);
	});

	it('keeps only the selected protocol (hy2 maps to hysteria2)', async () => {
		expect((await post('/filters', { url: source, types: 'hysteria2' })).status).toBe(200);
		expect(await refreshedLines()).toEqual([hy2]);
	});

	it('keeps several selected protocols', async () => {
		await post('/filters', { url: source, types: 'vless,trojan' });
		expect(await refreshedLines()).toEqual([vless, trojan]);
	});

	it('reports how many nodes the filter dropped', async () => {
		await post('/filters', { url: source, types: 'vmess' });
		const result = await refresh();
		expect(result.records).toBe(1);
		expect(result.debug.filteredOut).toBe(3);
	});

	it('only filters the source it is configured for', async () => {
		const other = inlineSource(vless);
		await env.KV_NAMESPACE.put('sources', JSON.stringify([source, other]));
		await post('/filters', { url: source, types: 'trojan' });
		// vless 同時出現在被過濾的來源與未過濾的 other 來源，後者仍要保留
		expect(await refreshedLines()).toEqual([trojan, vless]);
	});

	it('clears the filter when no type is sent', async () => {
		await post('/filters', { url: source, types: 'ss' });
		await post('/filters', { url: source, types: '' });
		expect(await (await api('/filters')).json()).toEqual({});
	});

	it('drops unknown protocol names', async () => {
		await post('/filters', { url: source, types: 'vless,bogus,<script>' });
		expect(await (await api('/filters')).json()).toEqual({ [source]: ['vless'] });
	});

	it('treats corrupted stored filters as "no filter"', async () => {
		await env.KV_NAMESPACE.put('source_filters', JSON.stringify({ [source]: 'vless', other: ['bogus'], list: [] }));
		expect(await (await api('/filters')).json()).toEqual({});
		expect(await refreshedLines()).toEqual([vmess, vless, trojan, hy2]);
	});
});

describe('/filters route', () => {
	it('requires login', async () => {
		expect((await SELF.fetch('https://example.com/filters')).status).toBe(401);
		const res = await SELF.fetch('https://example.com/filters', { method: 'POST', body: new URLSearchParams({ url: source }) });
		expect(res.status).toBe(401);
	});

	it('rejects methods outside the contract', async () => {
		expect((await api('/filters', { method: 'DELETE' })).status).toBe(405);
	});

	it('validates the target source', async () => {
		expect((await post('/filters', { types: 'vless' })).status).toBe(400);
		expect((await post('/filters', { url: 'inline:not-registered', types: 'vless' })).status).toBe(404);
	});

	it('removes the filter together with its source', async () => {
		await post('/filters', { url: source, types: 'vless' });
		expect((await post('/remove', { url: source })).status).toBe(200);
		expect(await (await api('/filters')).json()).toEqual({});
	});
});
