import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { runUpdate } from '../src/update';
import { inlineSource, vlessLine } from './helpers';

describe('base64 output toggle', () => {
	it('forces a full rewrite when the flag flips, and only once', async () => {
		await env.KV_NAMESPACE.put('base64_encode', '0');
		await env.KV_NAMESPACE.put('chunk_size', '2');
		await env.KV_NAMESPACE.put('sources', JSON.stringify([inlineSource([vlessLine(1), vlessLine(2), vlessLine(3)].join('\n'))]));

		const first = await runUpdate(env as any);
		expect(first.chunks.total).toBe(2);
		expect(await env.KV_NAMESPACE.get('last_base64_setting')).toBe('0');
		expect(await env.KV_NAMESPACE.get('sub_txt_1')).toContain('vless://');

		// 內容沒變 → 不該重寫
		const again = await runUpdate(env as any);
		expect(again.changedChunks).toEqual([]);

		// 切換編碼 → 即使內容相同也必須整批重寫，否則輸出格式會與設定不一致
		await env.KV_NAMESPACE.put('base64_encode', '1');
		const flipped = await runUpdate(env as any);
		expect(flipped.changedChunks).toEqual([1, 2]);
		expect(await env.KV_NAMESPACE.get('last_base64_setting')).toBe('1');

		const encoded = await env.KV_NAMESPACE.get('sub_txt_1');
		expect(encoded).not.toContain('vless://');
		expect(atob(encoded!)).toContain('vless://');

		// 再跑一次：旗標與內容都一致 → 不重寫
		const stable = await runUpdate(env as any);
		expect(stable.changedChunks).toEqual([]);
	});

	it('keeps the flag untouched so a failed refresh still rewrites next time', async () => {
		// 模擬「旗標已翻新但分塊沒寫成功」的殘局：把旗標設成與目前設定相同，
		// 但刪掉分塊內容與 ETag，下一次刷新仍必須把分塊補回來。
		await env.KV_NAMESPACE.put('chunk_size', '400');
		await env.KV_NAMESPACE.put('base64_encode', '1');
		await env.KV_NAMESPACE.put('last_base64_setting', '1');
		await env.KV_NAMESPACE.put('sources', JSON.stringify([inlineSource(vlessLine(1))]));
		await env.KV_NAMESPACE.delete('sub_txt_1');
		await env.KV_NAMESPACE.delete('etag_1');

		const r = await runUpdate(env as any);
		expect(r.changedChunks).toEqual([1]);
		expect(atob((await env.KV_NAMESPACE.get('sub_txt_1'))!)).toContain('vless://');
	});
});
