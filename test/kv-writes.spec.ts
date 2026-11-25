import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { adminBearer, inlineSource, vlessLine } from './helpers';

// KV 免費額度每天只有 1000 次寫入：內容沒變的刷新／設定儲存不應該產生寫入。
// 做法：把受測 key 改成哨兵值，再執行一次「沒有變化」的操作；key 仍是哨兵代表沒被覆寫。

async function api(path: string, init: RequestInit = {}): Promise<Response> {
	return SELF.fetch(`https://example.com${path}`, {
		...init,
		headers: { Authorization: `Bearer ${await adminBearer()}` },
	});
}

async function refresh(): Promise<any> {
	await env.KV_NAMESPACE.delete('refresh_started_at');
	const res = await api('/refresh', { method: 'POST' });
	expect(res.status).toBe(200);
	return res.json();
}

async function seed(lines: number): Promise<void> {
	const body = Array.from({ length: lines }, (_, i) => vlessLine(i)).join('\n');
	await env.KV_NAMESPACE.put('sources', JSON.stringify([inlineSource(body)]));
	await env.KV_NAMESPACE.put('chunk_size', '400');
	await env.KV_NAMESPACE.put('base64_encode', '0');
}

describe('KV write budget', () => {
	it('does not rewrite bookkeeping keys when a refresh changes nothing', async () => {
		await seed(3);
		await refresh();

		await env.KV_NAMESPACE.put('last_updated_iso', 'sentinel');
		await env.KV_NAMESPACE.put('last_stats', 'sentinel');
		const second = await refresh();

		expect(second.updated).toBe(false);
		expect(await env.KV_NAMESPACE.get('last_updated_iso')).toBe('sentinel');
		// last_stats 內容與上次相同才會跳過；這裡的哨兵不同，所以會被修正回真實統計。
		expect(await env.KV_NAMESPACE.get('last_stats')).not.toBe('sentinel');
	});

	it('skips last_stats when the stats are identical', async () => {
		await seed(3);
		await refresh();
		const stats = await env.KV_NAMESPACE.get('last_stats');
		expect(stats).toBeTruthy();
		await refresh();
		expect(await env.KV_NAMESPACE.get('last_stats')).toBe(stats);
	});

	it('writes last_updated_iso when the content actually changes', async () => {
		await seed(3);
		await refresh();
		await env.KV_NAMESPACE.put('last_updated_iso', 'sentinel');
		await seed(4);
		const result = await refresh();

		expect(result.updated).toBe(true);
		expect(await env.KV_NAMESPACE.get('last_updated_iso')).not.toBe('sentinel');
	});

});
