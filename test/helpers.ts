import { env, SELF } from 'cloudflare:test';
import { signCookie } from '../src/auth';

/**
 * 測試共用的認證/來源小工具。
 * Bearer token 直接呼叫生產用的 `signCookie`，避免測試自己重寫一份簽章邏輯而與實作漂移。
 */
export async function adminBearer(password: string = env.ADMIN_PASSWORD): Promise<string> {
	return signCookie(password, { sub: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 });
}

let loginIpCounter = 0;

/** 每次登入都用不同的來源 IP，避免測試之間互相吃掉 /login 的限流額度。 */
export async function adminCookie(password: string = env.ADMIN_PASSWORD): Promise<string> {
	loginIpCounter += 1;
	const res = await SELF.fetch('https://example.com/login', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': `10.1.0.${loginIpCounter}` },
		body: new URLSearchParams({ password }),
	});
	if (!res.ok) throw new Error(`login failed: ${res.status}`);
	const setCookie = res.headers.get('set-cookie') || '';
	const value = setCookie.split(';')[0];
	if (!value) throw new Error('missing set-cookie');
	return value;
}

export async function subscriptionToken(): Promise<string> {
	const res = await SELF.fetch('https://example.com/config', {
		headers: { Authorization: `Bearer ${await adminBearer()}` },
	});
	if (!res.ok) throw new Error(`config failed: ${res.status}`);
	const cfg = (await res.json()) as { subscription_token: string };
	return cfg.subscription_token;
}

export function inlineSource(content: string): string {
	return `inline:${content}`;
}

export function vlessLine(index: number, extraParams = ''): string {
	return `vless://11111111-1111-1111-1111-111111111111@h${index}.test:443?sni=h${index}.test${extraParams}#v${index}`;
}
