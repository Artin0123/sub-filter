/**
 * Cloudflare Pages API & Subscription Logic
 */

import { KV_KEYS } from './kv';
import { cacheGet, cachePut, withCacheControl } from './cache';
import { signCookie, verifyCookie } from './auth';
import { runUpdate } from './update';
import { sha256Hex } from './hash';

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string, maxRequests: number, windowMs: number): boolean {
	const now = Date.now();
	const record = rateLimitMap.get(ip);
	if (!record || now > record.resetAt) {
		rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
		return true;
	}
	if (record.count >= maxRequests) return false;
	record.count++;
	return true;
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);
	if (aBytes.length !== bBytes.length) return false;
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
	const authHeader = req.headers.get('Authorization');
	if (authHeader && authHeader.startsWith('Bearer ')) {
		const token = authHeader.substring(7);
		const secret = env.ADMIN_PASSWORD;
		if (secret) {
			try {
				const payload = await verifyCookie(secret, token);
				if (payload && payload.sub === 'admin') return true;
			} catch {}
		}
	}

	const cookie = getCookie(req, 'session');
	if (!cookie) return false;
	const secret = env.ADMIN_PASSWORD;
	if (!secret) return false;
	try {
		const payload = await verifyCookie(secret, cookie);
		return !!payload;
	} catch {
		return false;
	}
}

async function generateSubscriptionToken(password: string): Promise<string> {
	const data = new TextEncoder().encode(password);
	const digest = await crypto.subtle.digest('SHA-256', data);
	const bytes = new Uint8Array(digest);
	let hex = '';
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i].toString(16).padStart(2, '0');
	}
	return hex.substring(0, 16);
}

async function handleSubChunk(request: Request, env: Env, index: number): Promise<Response> {
	const url = new URL(request.url);
	const token = url.searchParams.get('token');
	const validToken = await generateSubscriptionToken(env.ADMIN_PASSWORD || '');


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

// ... (Other handlers like handleAdminLogin, handleAdminList remain similar but focus on data) ...

async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
	const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
	if (!checkRateLimit(clientIP, 5, 60000)) return new Response('Too Many Requests', { status: 429 });
	const body = await parseBody(request);
	if (!env.ADMIN_PASSWORD) return new Response('ADMIN_PASSWORD not configured', { status: 500 });
	const ok = typeof body.password === 'string' && body.password === env.ADMIN_PASSWORD;
	if (!ok) return new Response('Unauthorized', { status: 401 });
	const token = await signCookie(env.ADMIN_PASSWORD, { sub: 'admin', exp: Math.floor(Date.now() / 1000) + 86400 });
	return new Response('OK', { headers: { 'set-cookie': setSessionCookie(token) } });
}

async function handleAdminConfigGet(request: Request, env: Env): Promise<Response> {
	if (!(await requireLogin(request, env))) return new Response('Unauthorized', { status: 401 });
	const chunkSizeStr = await env.KV_NAMESPACE.get(KV_KEYS.chunkSize);
	const chunk_size = chunkSizeStr ? parseInt(chunkSizeStr, 10) : 400;
	const base64EncodeStr = await env.KV_NAMESPACE.get(KV_KEYS.base64Encode);
	const base64_encode = base64EncodeStr === '1';
	const subscription_token = await generateSubscriptionToken(env.ADMIN_PASSWORD || '');
	return new Response(JSON.stringify({ chunk_size, base64_encode, subscription_token }), { headers: { 'content-type': 'application/json' } });
}


async function handleAdminLogout(): Promise<Response> {
	return new Response('OK', { headers: { 'set-cookie': clearSessionCookie() } });
}

async function handleAdminList(request: Request, env: Env): Promise<Response> {
	if (!(await requireLogin(request, env))) return new Response('Unauthorized', { status: 401 });
	const sources = await env.KV_NAMESPACE.get(KV_KEYS.sources, { type: 'json' }) as string[] | null;
	return new Response(JSON.stringify(sources ?? []), { headers: { 'content-type': 'application/json' } });
}

async function handleAdminAdd(request: Request, env: Env): Promise<Response> {
	if (!(await requireLogin(request, env))) return new Response('Unauthorized', { status: 401 });
	const body = await parseBody(request);
	const url = String(body.url || '').trim();
	if (!url) return new Response('Bad Request', { status: 400 });
	const sources = ((await env.KV_NAMESPACE.get(KV_KEYS.sources, { type: 'json' })) as string[] | null) ?? [];
	if (!sources.includes(url)) {
		sources.push(url);
		await env.KV_NAMESPACE.put(KV_KEYS.sources, JSON.stringify(sources));
	}
	return new Response('OK');
}

async function handleAdminRemove(request: Request, env: Env): Promise<Response> {
	if (!(await requireLogin(request, env))) return new Response('Unauthorized', { status: 401 });
	const body = await parseBody(request);
	const url = String(body.url || '').trim();
	if (!url) return new Response('Bad Request', { status: 400 });
	const sources = ((await env.KV_NAMESPACE.get(KV_KEYS.sources, { type: 'json' })) as string[] | null) ?? [];
	const next = sources.filter((s) => s !== url);
	await env.KV_NAMESPACE.put(KV_KEYS.sources, JSON.stringify(next));
	return new Response('OK');
}

async function handleAdminConfigPost(request: Request, env: Env): Promise<Response> {
	if (!(await requireLogin(request, env))) return new Response('Unauthorized', { status: 401 });
	const body = await parseBody(request);
	const n = Number(body.chunk_size);
	if (!Number.isInteger(n) || n < 50 || n > 2000) return new Response('Bad Request', { status: 400 });
	await env.KV_NAMESPACE.put(KV_KEYS.chunkSize, String(n));
	const base64Encode = body.base64_encode === '1' || body.base64_encode === 'true';
	await env.KV_NAMESPACE.put(KV_KEYS.base64Encode, base64Encode ? '1' : '0');
	return new Response('OK');
}

async function handleRefresh(request: Request, env: Env): Promise<Response> {
	if (!(await requireLogin(request, env))) return new Response('Unauthorized', { status: 401 });
	try {
		const result = await runUpdate(env);
		return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
	} catch (e: any) {
		return new Response(JSON.stringify({ error: 'refresh_failed', message: e.message }), { status: 500 });
	}
}

async function handleDebug(request: Request, env: Env): Promise<Response> {
	if (!(await requireLogin(request, env))) return new Response('Unauthorized', { status: 401 });
	const sources = await env.KV_NAMESPACE.get(KV_KEYS.sources, { type: 'json' });
	return new Response(JSON.stringify({ sources, status: 'ok' }, null, 2), { headers: { 'content-type': 'application/json' } });
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname;

		// API & Subscriptions
		const subMatch = pathname.match(/^\/sub_(\d+)$/);
		if (subMatch) return handleSubChunk(request, env, parseInt(subMatch[1], 10));

		if (pathname === '/' || pathname === '/index.html') {
			if (!(await requireLogin(request, env))) {
				return Response.redirect(new URL('/login-page.html', request.url).toString(), 302);
			}
			// When authenticated, fallback to serving static asset
			return env.ASSETS.fetch(request);
		}

		switch (pathname) {
			case '/login': return request.method === 'POST' ? handleAdminLogin(request, env) : new Response('Method Not Allowed', { status: 405 });
			case '/logout': return handleAdminLogout();
			case '/list': return handleAdminList(request, env);
			case '/add': return handleAdminAdd(request, env);
			case '/remove': return handleAdminRemove(request, env);
			case '/config': return request.method === 'POST' ? handleAdminConfigPost(request, env) : handleAdminConfigGet(request, env);
			case '/refresh': return handleRefresh(request, env);
			case '/debug': return handleDebug(request, env);
			default:
				// Return env.ASSETS.fetch(request) to let Pages Middleware handle static files like /admin.css or /admin.js
				return env.ASSETS.fetch(request);
		}
	},
} satisfies ExportedHandler<Env>;
