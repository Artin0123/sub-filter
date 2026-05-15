import { signCookie } from '../auth';
import { clearSessionCookie, setSessionCookie } from '../lib/cookies';
import type { AppEnv } from '../lib/env';
import { parseBody } from '../lib/http';

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

export async function handleAdminLogin(request: Request, env: AppEnv): Promise<Response> {
	const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
	if (!checkRateLimit(clientIP, 5, 60000)) return new Response('Too Many Requests', { status: 429 });
	const body = await parseBody(request);
	if (!env.ADMIN_PASSWORD) return new Response('ADMIN_PASSWORD not configured', { status: 500 });
	const ok = typeof body.password === 'string' && body.password === env.ADMIN_PASSWORD;
	if (!ok) return new Response('Unauthorized', { status: 401 });
	const token = await signCookie(env.ADMIN_PASSWORD, { sub: 'admin', exp: Math.floor(Date.now() / 1000) + 86400 });
	return new Response('OK', { headers: { 'set-cookie': setSessionCookie(token) } });
}

export async function handleAdminLogout(): Promise<Response> {
	return new Response('OK', { headers: { 'set-cookie': clearSessionCookie() } });
}
