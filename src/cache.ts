// 這裡只包一層最小的 Cloudflare edge cache 操作。
// 不做複雜策略，只統一快取 TTL 和寫入前 clone 的行為。

// 訂閱分塊共用的 cache 策略；304 與 200 回應都必須帶同一份標頭。
export const SUBSCRIPTION_CACHE_CONTROL = 'public, max-age=300, must-revalidate';

// Cache API 只接受 GET 請求，對 HEAD 或其他 method 呼叫 put() 會直接拋錯。
export async function cacheGet(request: Request): Promise<Response | undefined> {
	if (request.method !== 'GET') return undefined;
	return caches.default.match(request);
}

export async function cachePut(request: Request, response: Response): Promise<void> {
	if (request.method !== 'GET') return;
	// Response body 是 stream，寫入 cache 前要重新包一層，避免下游重複讀取出錯。
	const toCache = new Response(response.body, {
		headers: new Headers(response.headers),
		status: response.status,
		statusText: response.statusText,
	});
	await caches.default.put(request, toCache);
}
