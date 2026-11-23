import { toBase64Url, verifyCookie } from '../auth';
import { KV_KEYS } from '../kv';
import { getCookie } from '../lib/cookies';
import type { AppEnv } from '../lib/env';

export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);
	if (aBytes.length !== bBytes.length) return false;
	return await crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

async function verifyAdminToken(secret: string, token: string): Promise<boolean> {
	const payload = await verifyCookie(secret, token);
	return !!payload && payload.sub === 'admin';
}

/**
 * 管理後台接受兩種登入憑證：
 * 1. 正常後台頁面使用的 session cookie
 * 2. 自動化流程使用的 Bearer token
 * 兩者共用同一套 HMAC 簽章格式，驗證標準也一致（都要求 `sub === 'admin'`）。
 */
export async function requireLogin(req: Request, env: AppEnv): Promise<boolean> {
	const secret = env.ADMIN_PASSWORD;
	if (!secret) return false;

	const authHeader = req.headers.get('Authorization');
	if (authHeader && authHeader.startsWith('Bearer ')) {
		try {
			if (await verifyAdminToken(secret, authHeader.slice('Bearer '.length).trim())) return true;
		} catch {
			// 格式錯誤的 Bearer token 一律視為未登入，繼續嘗試 cookie。
		}
	}

	const cookie = getCookie(req, 'session');
	if (!cookie) return false;
	try {
		return await verifyAdminToken(secret, cookie);
	} catch {
		return false;
	}
}

// 訂閱端點使用的 token 大小（24 bytes → 32 字元的 base64url）。
const SUBSCRIPTION_TOKEN_BYTES = 24;

/**
 * 讀取訂閱 token（只讀）。
 * 訂閱端點走這條路徑：未經授權的請求不會在 KV 產生任何寫入。
 */
export async function readSubscriptionToken(env: AppEnv): Promise<string | null> {
	return env.KV_NAMESPACE.get(KV_KEYS.subscriptionToken);
}

/**
 * 取得訂閱 token，不存在時建立一次並寫入 KV。
 *
 * 只有後台設定（`GET /config`）會呼叫這裡。把建立動作限制在單一管理員路徑，
 * 可以避免多個 colo 同時收到匿名請求時各自建立 token、互相覆蓋。
 *
 * token 不帶 TTL、沒有輪換機制：寫入後就一直有效，直到有人手動刪除或覆寫
 * `subscription_token` 這個 key（例如重建 KV namespace）。
 */
export async function getOrCreateSubscriptionToken(env: AppEnv): Promise<string> {
	const existing = await readSubscriptionToken(env);
	if (existing) return existing;

	const created = toBase64Url(crypto.getRandomValues(new Uint8Array(SUBSCRIPTION_TOKEN_BYTES)));
	await env.KV_NAMESPACE.put(KV_KEYS.subscriptionToken, created);
	const confirmed = await readSubscriptionToken(env);
	return confirmed || created;
}

/**
 * 訂閱 token 驗證，使用常數時間比較，避免 token 被逐字元探測。
 * KV 內沒有 token 時一律視為未授權，不會在驗證過程中建立新 token。
 */
export async function isValidSubscriptionToken(env: AppEnv, token: string): Promise<boolean> {
	if (!token) return false;
	const current = await readSubscriptionToken(env);
	if (!current) return false;
	return constantTimeEqual(token, current);
}
