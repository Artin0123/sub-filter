/**
 * 這個檔案現在只保留 Pages 對外入口。
 * 真正的路由拆分放在 `src/routes/`，避免再把所有邏輯塞回單檔。
 */
import type { AppEnv } from './lib/env';
import { routeRequest } from './routes';

export async function handleRequest(request: Request, env: AppEnv): Promise<Response> {
	return routeRequest(request, env);
}

export default {
	async fetch(request, env: AppEnv): Promise<Response> {
		return handleRequest(request, env);
	},
} satisfies ExportedHandler<AppEnv>;
