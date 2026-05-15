import { cacheGet, cachePut, withCacheControl } from '../cache';
import { KV_KEYS } from '../kv';
import type { AppEnv } from '../lib/env';
import { constantTimeEqual, generateSubscriptionToken } from '../services/session';

export async function handleSubChunk(request: Request, env: AppEnv, index: number): Promise<Response> {
	const url = new URL(request.url);
	const token = url.searchParams.get('token');
	if (!env.ADMIN_PASSWORD) {
		return new Response('ADMIN_PASSWORD not configured', { status: 500 });
	}
	const validToken = await generateSubscriptionToken(env.ADMIN_PASSWORD);

	if (!token || !(await constantTimeEqual(token, validToken))) {
		return new Response('Unauthorized', { status: 401 });
	}

	const totalStr = await env.KV_NAMESPACE.get(KV_KEYS.chunksTotal);
	const total = totalStr ? parseInt(totalStr, 10) : 0;
	if (!(index >= 1 && index <= total)) return new Response('Not Found', { status: 404 });

	const etag = await env.KV_NAMESPACE.get(KV_KEYS.etagI(index));
	const ifNone = request.headers.get('if-none-match');
	if (etag && ifNone && ifNone === etag) {
		return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'public, max-age=300, must-revalidate' } });
	}

	const cached = await cacheGet(request);
	if (cached) {
		const cachedEtag = cached.headers.get('etag');
		if (cachedEtag === etag) return cached;
	}

	const body = await env.KV_NAMESPACE.get(KV_KEYS.subTxtI(index));
	if (!body) return new Response('Not Found', { status: 404 });

	const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
	if (etag) headers.set('ETag', etag);
	let res = new Response(body, { headers });
	res = withCacheControl(res);
	await cachePut(request, res.clone());
	return res;
}
