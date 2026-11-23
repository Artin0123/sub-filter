import { cacheGet, cachePut, SUBSCRIPTION_CACHE_CONTROL } from '../cache';
import { KV_KEYS } from '../kv';
import type { AppEnv } from '../lib/env';
import { isValidSubscriptionToken } from '../services/session';

/**
 * RFC 9110 的 entity-tag 必須有引號，且 `If-None-Match` 可能是 `*`、逗號清單或 `W/"..."`。
 * opaque tag 本身可以包含逗號，所以不能直接用 `split(',')` 拆解，改成在原始字串上比對完整 tag。
 */
function matchesIfNoneMatch(header: string | null, etag: string): boolean {
	if (!header) return false;
	const value = header.trim();
	if (value === '*') return true;
	const escaped = etag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(?:^|,)\\s*(?:W\\/)?${escaped}\\s*(?:,|$)`).test(value);
}

export async function handleSubChunk(request: Request, env: AppEnv, index: number): Promise<Response> {
	const token = new URL(request.url).searchParams.get('token') ?? '';
	if (!(await isValidSubscriptionToken(env, token))) {
		return new Response('Unauthorized', { status: 401 });
	}

	const totalStr = await env.KV_NAMESPACE.get(KV_KEYS.chunksTotal);
	const total = totalStr ? parseInt(totalStr, 10) : 0;
	if (!(index >= 1 && index <= total)) return new Response('Not Found', { status: 404 });

	const etagValue = await env.KV_NAMESPACE.get(KV_KEYS.etagI(index));
	const etag = etagValue ? `"${etagValue}"` : null;

	// 200 與 304 共用同一份標頭。
	const headers = new Headers({ 'cache-control': SUBSCRIPTION_CACHE_CONTROL });
	if (etag) headers.set('etag', etag);

	if (etag && matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
		return new Response(null, { status: 304, headers });
	}

	const cached = await cacheGet(request);
	// 快取內容只有在 ETag 與 KV 現值一致時才能回，避免來源更新後仍吐舊分塊。
	if (cached && cached.headers.get('etag') === etag) return cached;

	const body = await env.KV_NAMESPACE.get(KV_KEYS.subTxtI(index));
	if (!body) return new Response('Not Found', { status: 404 });

	headers.set('content-type', 'text/plain; charset=utf-8');
	const res = new Response(body, { headers });
	await cachePut(request, res.clone());
	return res;
}
