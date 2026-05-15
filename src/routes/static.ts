import type { AppEnv } from '../lib/env';
import { requireLogin } from '../services/session';

/**
 * `/` 和 `/index.html` 必須先做服務端驗證。
 * 否則使用者會先看到後台頁，再讓每個 API 逐一打出 401。
 */
export async function handleStaticRequest(request: Request, env: AppEnv, pathname: string): Promise<Response> {
	if (pathname === '/' || pathname === '/index.html') {
		if (!(await requireLogin(request, env))) {
			return Response.redirect(new URL('/login-page.html', request.url).toString(), 302);
		}
	}
	return env.ASSETS.fetch(request);
}
