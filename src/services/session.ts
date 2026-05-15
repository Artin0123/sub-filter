import { verifyCookie } from '../auth';
import { getCookie } from '../lib/cookies';
import type { AppEnv } from '../lib/env';

export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);
	if (aBytes.length !== bBytes.length) return false;
	return await crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

/**
 * 管理後台接受兩種登入憑證：
 * 1. 正常後台頁面使用的 session cookie
 * 2. 自動化流程使用的 Bearer token
 */
export async function requireLogin(req: Request, env: AppEnv): Promise<boolean> {
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

/**
 * 訂閱端點使用的是獨立 token，不直接暴露後台 session。
 */
export async function generateSubscriptionToken(password: string): Promise<string> {
	const data = new TextEncoder().encode(password);
	const digest = await crypto.subtle.digest('SHA-256', data);
	const bytes = new Uint8Array(digest);
	let hex = '';
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i].toString(16).padStart(2, '0');
	}
	return hex.substring(0, 16);
}
