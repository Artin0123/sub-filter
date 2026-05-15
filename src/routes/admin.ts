import type { AppEnv } from '../lib/env';
import { KV_KEYS } from '../kv';
import { parseBody } from '../lib/http';
import { getAdminConfig, updateAdminConfig } from '../services/config';
import { refreshSubscriptions } from '../services/refresh';
import { requireLogin } from '../services/session';
import { addSource, InputTooLongError, listSources, removeSource } from '../services/source-store';

export async function handleAdminConfigGet(request: Request, env: AppEnv): Promise<Response> {
	if (!(await requireLogin(request, env))) return new Response('Unauthorized', { status: 401 });
	return new Response(JSON.stringify(await getAdminConfig(env)), { headers: { 'content-type': 'application/json' } });
}

export async function handleAdminList(request: Request, env: AppEnv): Promise<Response> {
	if (!(await requireLogin(request, env))) return new Response('Unauthorized', { status: 401 });
	return new Response(JSON.stringify(await listSources(env)), { headers: { 'content-type': 'application/json' } });
}

export async function handleAdminAdd(request: Request, env: AppEnv): Promise<Response> {
	if (!(await requireLogin(request, env))) return new Response('Unauthorized', { status: 401 });
	const body = await parseBody(request);
	const url = String(body.url || '').trim();
	if (!url) return new Response('Bad Request', { status: 400 });
	// 來源去重和持久化放在 service 層，route 只做請求校驗。
	try {
		await addSource(env, url);
	} catch (e) {
		if (e instanceof InputTooLongError) {
			return new Response(JSON.stringify({ error: 'input_too_long', message: e.message }), {
				status: 400,
				headers: { 'content-type': 'application/json' },
			});
		}
		throw e;
	}
	return new Response('OK');
}

export async function handleAdminRemove(request: Request, env: AppEnv): Promise<Response> {
	if (!(await requireLogin(request, env))) return new Response('Unauthorized', { status: 401 });
	const body = await parseBody(request);
	const url = String(body.url || '').trim();
	if (!url) return new Response('Bad Request', { status: 400 });
	await removeSource(env, url);
	return new Response('OK');
}

export async function handleAdminConfigPost(request: Request, env: AppEnv): Promise<Response> {
	if (!(await requireLogin(request, env))) return new Response('Unauthorized', { status: 401 });
	const body = await parseBody(request);
	const n = Number(body.chunk_size);
	if (!Number.isInteger(n) || n < 50 || n > 2000) return new Response('Bad Request', { status: 400 });
	const base64Encode = body.base64_encode === '1' || body.base64_encode === 'true';
	// route 只接受已校驗的值，真正寫入 KV 交給 config service。
	await updateAdminConfig(env, n, base64Encode);
	return new Response('OK');
}

export async function handleRefresh(request: Request, env: AppEnv): Promise<Response> {
	if (!(await requireLogin(request, env))) return new Response('Unauthorized', { status: 401 });
	try {
		// 刷新是最重的路徑，route 不直接知道更新流程的內部細節。
		const result = await refreshSubscriptions(env);
		return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
	} catch (e: any) {
		return new Response(JSON.stringify({ error: 'refresh_failed', message: e.message }), { status: 500 });
	}
}

export async function handleDebug(request: Request, env: AppEnv): Promise<Response> {
	if (!(await requireLogin(request, env))) return new Response('Unauthorized', { status: 401 });
	const sources = await listSources(env);
	const lastStats = await env.KV_NAMESPACE.get(KV_KEYS.lastStats, { type: 'json' });
	return new Response(JSON.stringify({ sources, status: 'ok', last_stats: lastStats }, null, 2), {
		headers: { 'content-type': 'application/json' },
	});
}
