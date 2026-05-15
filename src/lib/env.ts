/**
 * Pages 執行環境。
 * Cloudflare 在 Pages Functions 內會額外提供 `ASSETS` 供靜態資產回退使用。
 */
export type AppEnv = Env & {
	ADMIN_PASSWORD: string;
	KV_NAMESPACE: KVNamespace;
	ASSETS: {
		fetch: typeof fetch;
	};
};
