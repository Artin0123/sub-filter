/**
 * Pages 執行環境。
 * Cloudflare 在 Pages Functions 內會額外提供 `ASSETS` 供靜態資產回退使用。
 *
 * `KV_NAMESPACE` 由 `wrangler types` 產生在 `worker-configuration.d.ts`，
 * 其餘項目用模組宣告合併補上，讓 `Env`（Pages entry 用的型別）與 `AppEnv` 是同一份。
 */
declare global {
	namespace Cloudflare {
		interface Env {
			ADMIN_PASSWORD: string;
			ASSETS: {
				fetch: typeof fetch;
			};
		}
	}
}

export type AppEnv = Env;
