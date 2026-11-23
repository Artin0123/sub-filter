import { signCookie } from '../auth';
import { clearSessionCookie, setSessionCookie } from '../lib/cookies';
import type { AppEnv } from '../lib/env';
import { parseBody } from '../lib/http';
import { constantTimeEqual } from '../services/session';

const LOGIN_RATE_LIMIT_MAX = 5;
const LOGIN_RATE_LIMIT_WINDOW_MS = 60_000;
// 只保留最近的來源位址，避免 Map 無上限成長。
const LOGIN_RATE_LIMIT_MAX_ENTRIES = 1024;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function sweepRateLimit(now: number): void {
	if (rateLimitMap.size < LOGIN_RATE_LIMIT_MAX_ENTRIES) return;
	for (const [key, record] of rateLimitMap) {
		if (now > record.resetAt) rateLimitMap.delete(key);
	}
}

/**
 * per-isolate 的盡力而為限流。
 * 不同 colo 各有自己的 Map，所以要擋大規模暴力破解還是得靠 Cloudflare WAF rate limiting，
 * 這一層只處理「同一個 isolate 內的連續嘗試」。
 */
function checkRateLimit(ip: string, maxRequests: number, windowMs: number): boolean {
	const now = Date.now();
	sweepRateLimit(now);
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
	if (!checkRateLimit(clientIP, LOGIN_RATE_LIMIT_MAX, LOGIN_RATE_LIMIT_WINDOW_MS)) {
		return new Response('Too Many Requests', { status: 429 });
	}
	const body = await parseBody(request);
	if (!env.ADMIN_PASSWORD) {
		// 這是部署設定問題：細節只進 log，回應保持泛用以免對匿名者洩漏組態。
		console.error('admin_password_not_configured');
		return new Response('Service Unavailable', { status: 503 });
	}
	// 與訂閱 token 一樣用常數時間比較，避免逐字元計時探測密碼。
	const ok = typeof body.password === 'string' && (await constantTimeEqual(body.password, env.ADMIN_PASSWORD));
	if (!ok) return new Response('Unauthorized', { status: 401 });
	const token = await signCookie(env.ADMIN_PASSWORD, { sub: 'admin', exp: Math.floor(Date.now() / 1000) + 86400 });
	return new Response('OK', { headers: { 'set-cookie': setSessionCookie(token) } });
}

export async function handleAdminLogout(): Promise<Response> {
	return new Response('OK', { headers: { 'set-cookie': clearSessionCookie() } });
}
