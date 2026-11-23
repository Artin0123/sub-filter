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

type Handler = (request: Request, env: AppEnv) => Promise<Response>;

type Route = {
	// 允許的 HTTP method。沒有列出的 method 一律回 405，避免「GET 也能觸發寫入操作」。
	methods: readonly string[];
	handler: Handler;
};

const ROUTES: Record<string, Route> = {
	'/login': { methods: ['POST'], handler: handleAdminLogin },
	'/logout': { methods: ['POST'], handler: () => handleAdminLogout() },
	'/list': { methods: ['GET'], handler: handleAdminList },
	'/add': { methods: ['POST'], handler: handleAdminAdd },
	'/remove': { methods: ['POST'], handler: handleAdminRemove },
	'/config': {
		methods: ['GET', 'POST'],
		handler: (req, env) => (req.method === 'POST' ? handleAdminConfigPost(req, env) : handleAdminConfigGet(req, env)),
	},
	'/refresh': { methods: ['POST'], handler: handleRefresh },
	'/debug': { methods: ['GET'], handler: handleDebug },
};

// 訂閱端點會被打訂閱客戶端定期抓取；GET 之外也放行 HEAD。
const SUB_CHUNK_METHODS = ['GET', 'HEAD'] as const;
const SUB_CHUNK_PATTERN = /^\/sub_(\d+)$/;

function methodNotAllowed(methods: readonly string[]): Response {
	return new Response('Method Not Allowed', {
		status: 405,
		headers: { allow: methods.join(', ') },
	});
}

/**
 * Pages 唯一請求分發入口。
 * 這裡只負責「路徑 → handler」與 method 契約，不碰任何業務邏輯。
 */
export async function routeRequest(request: Request, env: AppEnv): Promise<Response> {
	const { pathname } = new URL(request.url);

	const subMatch = SUB_CHUNK_PATTERN.exec(pathname);
	if (subMatch) {
		if (!(SUB_CHUNK_METHODS as readonly string[]).includes(request.method)) return methodNotAllowed(SUB_CHUNK_METHODS);
		return handleSubChunk(request, env, parseInt(subMatch[1], 10));
	}

	const route = ROUTES[pathname];
	if (route) {
		if (!route.methods.includes(request.method)) return methodNotAllowed(route.methods);
		return route.handler(request, env);
	}

	// 未命中的路徑全部交還給 Pages 靜態資產服務處理。
	return handleStaticRequest(request, env, pathname);
}
