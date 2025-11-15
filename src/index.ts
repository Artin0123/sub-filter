/**
 * Cloudflare Workers subscription aggregator with chunking support
 */

import { KV_KEYS } from './kv';
import { cacheGet, cachePut, withCacheControl } from './cache';
import { signCookie, verifyCookie } from './auth';
import { runUpdate } from './update';
import { sha256Hex } from './hash';

// Rate limiting (in-memory, resets on worker restart)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string, maxRequests: number, windowMs: number): boolean {
	const now = Date.now();
	const record = rateLimitMap.get(ip);

	if (!record || now > record.resetAt) {
		rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
		return true;
	}

	if (record.count >= maxRequests) {
		return false;
	}

	record.count++;
	return true;
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);

	if (aBytes.length !== bBytes.length) {
		return false;
	}

	return await crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

function getCookie(req: Request, name: string): string | null {
	const raw = req.headers.get('cookie');
	if (!raw) return null;
	const parts = raw.split(/;\s*/);
	for (const p of parts) {
		const [k, v] = p.split('=');
		if (k === name) return decodeURIComponent(v ?? '');
	}
	return null;
}

function setSessionCookie(token: string, maxAgeSec = 24 * 60 * 60): string {
	const expires = new Date(Date.now() + maxAgeSec * 1000).toUTCString();
	return `session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires}`;
}

function clearSessionCookie(): string {
	const expires = new Date(0).toUTCString();
	return `session=; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires}`;
}

async function requireLogin(req: Request, env: Env): Promise<boolean> {
	const cookie = getCookie(req, 'session');
	if (!cookie) return false;
	const secret = env.ADMIN_PASSWORD;
	if (!secret || typeof secret !== 'string' || secret.length === 0) return false;
	try {
		const payload = await verifyCookie(secret, cookie);
		return !!payload;
	} catch {
		return false;
	}
}

async function generateSubscriptionToken(password: string): Promise<string> {
	const hash = await sha256Hex(password);
	return hash.substring(0, 16); // 16 chars = 64 bits
}

async function handleSubChunk(request: Request, env: Env, index: number): Promise<Response> {
	const url = new URL(request.url);
	const token = url.searchParams.get('token');
	const validToken = await generateSubscriptionToken(env.ADMIN_PASSWORD || '');

	// Constant-time comparison to prevent timing attacks
	if (!token || !(await constantTimeEqual(token, validToken))) {
		return new Response('Unauthorized', { status: 401 });
	}

	const totalStr = await env.KV_NAMESPACE.get(KV_KEYS.chunksTotal);
	const total = totalStr ? parseInt(totalStr, 10) : 0;
	if (!(index >= 1 && index <= total)) return new Response('Not Found', { status: 404 });

	const etag = await env.KV_NAMESPACE.get(KV_KEYS.etagI(index));
	const ifNone = request.headers.get('if-none-match');

	// Check ETag first
	if (etag && ifNone && ifNone === etag) {
		return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'public, max-age=300, must-revalidate' } });
	}

	// Check edge cache, but verify ETag matches
	const cached = await cacheGet(request);
	if (cached) {
		const cachedEtag = cached.headers.get('etag');
		if (cachedEtag === etag) {
			return cached;
		}
		// ETag mismatch, cache is stale, continue to fetch fresh content
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

async function handleAdminPage(request: Request, env: Env): Promise<Response> {
	const loggedIn = await requireLogin(request, env);
	const file = loggedIn ? '/admin.html' : '/login-page.html';
	return env.ASSETS.fetch(new URL(file, request.url));
}

async function parseBody(req: Request): Promise<Record<string, any>> {
	const ct = req.headers.get('content-type') || '';
	try {
		if (ct.includes('application/json')) return await req.json();
	} catch { }
	if (ct.includes('application/x-www-form-urlencoded')) {
		const form = await req.formData();
		const obj: Record<string, any> = {};
		for (const [k, v] of form.entries()) obj[k] = typeof v === 'string' ? v : String(v);
		return obj;
	}
	const text = await req.text();
	const params = new URLSearchParams(text);
	const obj: Record<string, any> = {};
	for (const [k, v] of params.entries()) obj[k] = v;
	return obj;
}

async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
	// Rate limiting: 5 attempts per minute per IP
	const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
	if (!checkRateLimit(clientIP, 5, 60000)) {
		return new Response('Too Many Requests', { status: 429 });
	}

	const body = await parseBody(request);
	if (!env.ADMIN_PASSWORD) {
		return new Response('ADMIN_PASSWORD not configured', { status: 500 });
	}
	const ok = typeof body.password === 'string' && body.password === env.ADMIN_PASSWORD;
	if (!ok) return new Response('Unauthorized', { status: 401 });
	const token = await signCookie(env.ADMIN_PASSWORD, { sub: 'admin', exp: Math.floor(Date.now() / 1000) + 86400 });
	return new Response('OK', {
		headers: { 'set-cookie': setSessionCookie(token) },
	});
}

async function handleAdminLogout(): Promise<Response> {
	return new Response('OK', {
		headers: { 'set-cookie': clearSessionCookie() },
	});
}

async function ensureAuth(request: Request, env: Env): Promise<Response | null> {
	const ok = await requireLogin(request, env);
	if (!ok) return new Response('Unauthorized', { status: 401 });
	return null;
}

async function handleAdminList(request: Request, env: Env): Promise<Response> {
	const unauth = await ensureAuth(request, env); if (unauth) return unauth;
	const sources = (await env.KV_NAMESPACE.get(KV_KEYS.sources, { type: 'json' })) as string[] | null;
	return new Response(JSON.stringify(sources ?? []), { headers: { 'content-type': 'application/json' } });
}

async function handleAdminAdd(request: Request, env: Env): Promise<Response> {
	const unauth = await ensureAuth(request, env); if (unauth) return unauth;
	const body = await parseBody(request);
	const url = String(body.url || '').trim();
	if (!url) return new Response('Bad Request', { status: 400 });
	const sources = ((await env.KV_NAMESPACE.get(KV_KEYS.sources, { type: 'json' })) as string[] | null) ?? [];
	if (!sources.includes(url)) sources.push(url);
	await env.KV_NAMESPACE.put(KV_KEYS.sources, JSON.stringify(sources));
	return new Response('OK');
}

async function handleAdminRemove(request: Request, env: Env): Promise<Response> {
	const unauth = await ensureAuth(request, env); if (unauth) return unauth;
	const body = await parseBody(request);
	const url = String(body.url || '').trim();
	if (!url) return new Response('Bad Request', { status: 400 });
	const sources = ((await env.KV_NAMESPACE.get(KV_KEYS.sources, { type: 'json' })) as string[] | null) ?? [];
	const next = sources.filter((s) => s !== url);
	await env.KV_NAMESPACE.put(KV_KEYS.sources, JSON.stringify(next));
	return new Response('OK');
}

async function handleAdminConfigGet(request: Request, env: Env): Promise<Response> {
	const unauth = await ensureAuth(request, env); if (unauth) return unauth;
	const chunkSizeStr = await env.KV_NAMESPACE.get(KV_KEYS.chunkSize);
	const chunk_size = chunkSizeStr ? parseInt(chunkSizeStr, 10) : 400;
	const base64EncodeStr = await env.KV_NAMESPACE.get(KV_KEYS.base64Encode);
	const base64_encode = base64EncodeStr === '1';
	const subscription_token = await generateSubscriptionToken(env.ADMIN_PASSWORD || '');
	return new Response(JSON.stringify({ chunk_size, base64_encode, subscription_token }), { headers: { 'content-type': 'application/json' } });
}

async function handleAdminConfigPost(request: Request, env: Env): Promise<Response> {
	const unauth = await ensureAuth(request, env); if (unauth) return unauth;
	const body = await parseBody(request);
	const n = Number(body.chunk_size);
	if (!Number.isInteger(n) || n < 50 || n > 2000) return new Response('Bad Request', { status: 400 });
	await env.KV_NAMESPACE.put(KV_KEYS.chunkSize, String(n));

	const base64Encode = body.base64_encode === '1' || body.base64_encode === 'true';
	await env.KV_NAMESPACE.put(KV_KEYS.base64Encode, base64Encode ? '1' : '0');

	return new Response('OK');
}

async function handleRefresh(request: Request, env: Env): Promise<Response> {
	// Rate limiting: 10 attempts per 10 minutes per IP
	const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
	if (!checkRateLimit(clientIP, 10, 600000)) {
		return new Response('Too Many Requests', { status: 429 });
	}

	let ok = false;
	const auth = request.headers.get('authorization');
	if (auth && auth.startsWith('Bearer ')) {
		const token = auth.split(' ')[1] ?? '';
		// Use HMAC-signed token instead of plain password
		try {
			const payload = await verifyCookie(env.ADMIN_PASSWORD, token);
			ok = !!payload;
		} catch {
			ok = false;
		}
	}
	if (!ok) {
		ok = await requireLogin(request, env);
	}
	if (!ok) return new Response('Unauthorized', { status: 401 });

	if (!env.KV_NAMESPACE || typeof (env.KV_NAMESPACE as any).get !== 'function') {
		return new Response(JSON.stringify({ error: 'kv_binding_missing', message: 'KV_NAMESPACE binding is missing or invalid' }), { status: 500, headers: { 'content-type': 'application/json' } });
	}
	try {
		const result = await runUpdate(env);
		return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
	} catch (e: any) {
		console.error('refresh failed', e);

		// Only return safe error messages
		const errorName = e?.name || 'unknown';
		const safeErrors = ['TypeError', 'SyntaxError', 'AbortError'];
		const message = safeErrors.includes(errorName)
			? `Refresh failed: ${errorName}`
			: 'Refresh failed. Please check logs for details.';

		return new Response(JSON.stringify({ error: 'refresh_failed', message }), { status: 500, headers: { 'content-type': 'application/json' } });
	}
}

async function handleDebug(request: Request, env: Env): Promise<Response> {
	const unauth = await ensureAuth(request, env); if (unauth) return unauth;
	const chunkSizeStr = await env.KV_NAMESPACE.get(KV_KEYS.chunkSize);
	const sources = (await env.KV_NAMESPACE.get(KV_KEYS.sources, { type: 'json' })) as string[] | null;
	const chunkSizeEffective = chunkSizeStr ? parseInt(chunkSizeStr, 10) : 400;
	const lastStats = await env.KV_NAMESPACE.get(KV_KEYS.lastStats, { type: 'json' }) as any | null;
	const info: any = {
		kvBindingType: typeof (env.KV_NAMESPACE as any),
		hasGet: typeof (env.KV_NAMESPACE as any)?.get === 'function',
		chunk_size_raw: chunkSizeStr,
		chunk_size_effective: chunkSizeEffective,
		sources_count: Array.isArray(sources) ? sources.length : 0,
		sources: Array.isArray(sources) ? sources : [],
		sources_contains_gist: Array.isArray(sources) ? sources.some(s => s.includes('gist.githubusercontent.com')) : false,
		last_stats: lastStats || undefined,
	};
	return new Response(JSON.stringify(info, null, 2), { headers: { 'content-type': 'application/json' } });
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname;

		// Static files (CSS, JS, HTML)
		if (pathname === '/admin.css' || pathname === '/admin.js' || pathname === '/login.js' || pathname === '/login-page.html' || pathname === '/admin.html') {
			return env.ASSETS.fetch(request);
		}

		// Public subscription endpoints (chunked only)
		// Support /sub_1, /sub_2, /sub_3, etc.
		const m = pathname.match(/^\/sub_(\d+)$/);
		if (request.method === 'GET' && m) {
			const idx = parseInt(m[1], 10);
			return handleSubChunk(request, env, idx);
		}

		// Admin UI and APIs
		if (request.method === 'GET' && pathname === '/') return handleAdminPage(request, env);
		if (request.method === 'POST' && pathname === '/login') return handleAdminLogin(request, env);
		if (request.method === 'POST' && pathname === '/logout') return handleAdminLogout();
		if (request.method === 'GET' && pathname === '/list') return handleAdminList(request, env);
		if (request.method === 'POST' && pathname === '/add') return handleAdminAdd(request, env);
		if (request.method === 'POST' && pathname === '/remove') return handleAdminRemove(request, env);
		if (request.method === 'GET' && pathname === '/config') return handleAdminConfigGet(request, env);
		if (request.method === 'POST' && pathname === '/config') return handleAdminConfigPost(request, env);
		if (request.method === 'GET' && pathname === '/debug') return handleDebug(request, env);

		// Refresh hook
		if (request.method === 'POST' && pathname === '/refresh') return handleRefresh(request, env);

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
