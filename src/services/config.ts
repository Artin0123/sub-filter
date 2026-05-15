import type { AppEnv } from '../lib/env';
import { KV_KEYS } from '../kv';
import { generateSubscriptionToken } from './session';

export type AdminConfig = {
	chunk_size: number;
	base64_encode: boolean;
	subscription_token: string;
};

/**
 * 後台設定目前集中存放在 KV。
 * 之後若改成 Dashboard 變數或其他來源，只需要改這一層。
 */
export async function getAdminConfig(env: AppEnv): Promise<AdminConfig> {
	const chunkSizeStr = await env.KV_NAMESPACE.get(KV_KEYS.chunkSize);
	const chunk_size = chunkSizeStr ? parseInt(chunkSizeStr, 10) : 400;
	const base64EncodeStr = await env.KV_NAMESPACE.get(KV_KEYS.base64Encode);
	const base64_encode = base64EncodeStr === '1';
	const subscription_token = await generateSubscriptionToken(env.ADMIN_PASSWORD || '');
	return { chunk_size, base64_encode, subscription_token };
}

export async function updateAdminConfig(env: AppEnv, chunkSize: number, base64Encode: boolean): Promise<void> {
	await env.KV_NAMESPACE.put(KV_KEYS.chunkSize, String(chunkSize));
	await env.KV_NAMESPACE.put(KV_KEYS.base64Encode, base64Encode ? '1' : '0');
}
