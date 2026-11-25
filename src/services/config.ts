import type { AppEnv } from '../lib/env';
import { KV_KEYS, putIfChanged } from '../kv';
import { getOrCreateSubscriptionToken } from './session';

export const CHUNK_SIZE_DEFAULT = 400;
// 使用者介面/route 層的合法範圍。
export const CHUNK_SIZE_MIN = 50;
export const CHUNK_SIZE_MAX = 2000;

/**
 * 把 KV 內的 chunk_size 正規化成安全值。
 * route 層會先用 400 拒絕越界輸入；這裡是執行期的第二道防線，
 * 避免 KV 被手動改壞（例如 `0` 或非數字）時更新流程陷入無窮迴圈或產生空分塊。
 * 注意：小於 CHUNK_SIZE_MIN 的正整數仍然接受（例如直接寫 KV 的 `2`），只擋 0 以下與非數字。
 */
export function normalizeChunkSize(raw: string | null | undefined): number {
	if (!raw) return CHUNK_SIZE_DEFAULT;
	const n = parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0) return CHUNK_SIZE_DEFAULT;
	return Math.min(n, CHUNK_SIZE_MAX);
}

export type AdminConfig = {
	chunk_size: number;
	base64_encode: boolean;
	subscription_token: string;
	chunks_total: number;
};

/**
 * 後台設定目前集中存放在 KV。
 * 之後若改成 Dashboard 變數或其他來源，只需要改這一層。
 */
export async function getAdminConfig(env: AppEnv): Promise<AdminConfig> {
	const [chunkSizeStr, base64EncodeStr, subscriptionToken, chunksTotalStr] = await Promise.all([
		env.KV_NAMESPACE.get(KV_KEYS.chunkSize),
		env.KV_NAMESPACE.get(KV_KEYS.base64Encode),
		getOrCreateSubscriptionToken(env),
		env.KV_NAMESPACE.get(KV_KEYS.chunksTotal),
	]);

	return {
		chunk_size: normalizeChunkSize(chunkSizeStr),
		base64_encode: base64EncodeStr === '1',
		subscription_token: subscriptionToken,
		chunks_total: chunksTotalStr ? parseInt(chunksTotalStr, 10) || 0 : 0,
	};
}

export async function updateAdminConfig(env: AppEnv, chunkSize: number, base64Encode: boolean): Promise<void> {
	await putIfChanged(env.KV_NAMESPACE, KV_KEYS.chunkSize, String(chunkSize));
	await putIfChanged(env.KV_NAMESPACE, KV_KEYS.base64Encode, base64Encode ? '1' : '0');
}
