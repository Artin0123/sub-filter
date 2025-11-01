// Cache wrappers for 5-minute edge cache

const CACHE_TTL_SECONDS = 300;

export async function cacheGet(request: Request): Promise<Response | undefined> {
    return caches.default.match(request);
}

export async function cachePut(request: Request, response: Response): Promise<void> {
    // Clone because body is a stream
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
