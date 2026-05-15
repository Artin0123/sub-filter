import type { AppEnv } from '../lib/env';
import { KV_KEYS } from '../kv';

/**
 * 訂閱來源清單由 KV 管理。
 * route 層不應直接依賴 key 名稱與序列化細節。
 */
export async function listSources(env: AppEnv): Promise<string[]> {
	const sources = await env.KV_NAMESPACE.get(KV_KEYS.sources, { type: 'json' }) as string[] | null;
	return sources ?? [];
}

export async function addSource(env: AppEnv, url: string): Promise<void> {
	const sources = await listSources(env);
	if (!sources.includes(url)) {
		sources.push(url);
		await env.KV_NAMESPACE.put(KV_KEYS.sources, JSON.stringify(sources));
	}
}

export async function removeSource(env: AppEnv, url: string): Promise<void> {
	const sources = await listSources(env);
	const next = sources.filter((source) => source !== url);
	await env.KV_NAMESPACE.put(KV_KEYS.sources, JSON.stringify(next));
}
