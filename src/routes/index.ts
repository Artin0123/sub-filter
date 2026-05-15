import type { AppEnv } from '../lib/env';
import { handleAdminLogin, handleAdminLogout } from './auth';
import {
	handleAdminAdd,
	handleAdminConfigGet,
	handleAdminConfigPost,
	handleAdminList,
	handleAdminRemove,
	handleDebug,
	handleRefresh,
} from './admin';
import { handleStaticRequest } from './static';
import { handleSubChunk } from './subscription';

/**
 * Pages 唯一請求分發入口。
 * 這裡只負責判斷路徑並把請求轉交給對應 handler，避免再回到單檔大雜燴。
 */
export async function routeRequest(request: Request, env: AppEnv): Promise<Response> {
	const url = new URL(request.url);
	const pathname = url.pathname;

	const subMatch = pathname.match(/^\/sub_(\d+)$/);
	if (subMatch) return handleSubChunk(request, env, parseInt(subMatch[1], 10));

	switch (pathname) {
		case '/login':
			return request.method === 'POST' ? handleAdminLogin(request, env) : new Response('Method Not Allowed', { status: 405 });
		case '/logout':
			return handleAdminLogout();
		case '/list':
			return handleAdminList(request, env);
		case '/add':
			return handleAdminAdd(request, env);
		case '/remove':
			return handleAdminRemove(request, env);
		case '/config':
			return request.method === 'POST' ? handleAdminConfigPost(request, env) : handleAdminConfigGet(request, env);
		case '/refresh':
			return handleRefresh(request, env);
		case '/debug':
			return handleDebug(request, env);
		default:
			// 未命中的路徑全部交還給 Pages 靜態資產服務處理。
			return handleStaticRequest(request, env, pathname);
	}
}
