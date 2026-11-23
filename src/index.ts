/**
 * 這個檔案只保留 Pages 對外入口。
 * 真正的路由拆分放在 `src/routes/`，避免再把所有邏輯塞回單檔。
 */
import type { AppEnv } from './lib/env';
import { routeRequest } from './routes';

export async function handleRequest(request: Request, env: AppEnv): Promise<Response> {
	try {
		return await routeRequest(request, env);
	} catch (e) {
		// 任何未預期的例外都要留下痕跡，不然 runtime 只會回一個沒有上下文的 500。
		console.error('unhandled_request_error', request.method, new URL(request.url).pathname, e);
		return new Response(JSON.stringify({ error: 'internal_error' }), {
			status: 500,
			headers: { 'content-type': 'application/json' },
		});
	}
}

export default {
	async fetch(request, env: AppEnv): Promise<Response> {
		return handleRequest(request, env);
	},
} satisfies ExportedHandler<AppEnv>;
