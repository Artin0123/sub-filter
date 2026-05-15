// 這裡只包一層最小的 Cloudflare edge cache 操作。
// 不做複雜策略，只統一 5 分鐘快取和寫入前 clone 的行為。
export async function cacheGet(request: Request): Promise<Response | undefined> {
	return caches.default.match(request);
}

export async function cachePut(request: Request, response: Response): Promise<void> {
	// Response body 是 stream，寫入 cache 前要重新包一層，避免下游重複讀取出錯。
	const toCache = new Response(response.body, {
		headers: new Headers(response.headers),
		status: response.status,
		statusText: response.statusText,
	});
	await caches.default.put(request, toCache);
}

export function withCacheControl(res: Response): Response {
	const h = new Headers(res.headers);
	h.set('Cache-Control', 'public, max-age=300, must-revalidate');
	return new Response(res.body, { headers: h, status: res.status, statusText: res.statusText });
}
