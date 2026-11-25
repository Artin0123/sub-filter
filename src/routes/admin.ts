import type { AppEnv } from '../lib/env';
import { KV_KEYS } from '../kv';
import { parseBody } from '../lib/http';
import { CHUNK_SIZE_MAX, CHUNK_SIZE_MIN, getAdminConfig, updateAdminConfig } from '../services/config';
import { refreshSubscriptions, RefreshInProgressError } from '../services/refresh';
import { requireLogin } from '../services/session';
import { addSource, BlockedSourceError, getSourceFilters, InputTooLongError, listSources, removeSource, setSourceFilter, UnsupportedSourceError } from '../services/source-store';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function unauthorized(): Response {
	return new Response('Unauthorized', { status: 401 });
}

export async function handleAdminConfigGet(request: Request, env: AppEnv): Promise<Response> {
	if (!(await requireLogin(request, env))) return unauthorized();
	return jsonResponse(await getAdminConfig(env));
}

export async function handleAdminList(request: Request, env: AppEnv): Promise<Response> {
	if (!(await requireLogin(request, env))) return unauthorized();
	return jsonResponse(await listSources(env));
}

export async function handleAdminAdd(request: Request, env: AppEnv): Promise<Response> {
	if (!(await requireLogin(request, env))) return unauthorized();
	const body = await parseBody(request);
	const url = String(body.url || '').trim();
	if (!url) return new Response('Bad Request', { status: 400 });
	// 來源去重和持久化放在 service 層，route 只做請求校驗與錯誤轉譯。
	try {
		await addSource(env, url);
	} catch (e) {
		if (e instanceof InputTooLongError) {
			return jsonResponse({ error: 'input_too_long', message: e.message }, 400);
		}
		if (e instanceof UnsupportedSourceError) {
			return jsonResponse({ error: 'unsupported_source', message: e.message }, 400);
		}
		if (e instanceof BlockedSourceError) {
			return jsonResponse({ error: 'blocked_source', message: e.message }, 400);
		}
		throw e;
	}
	return new Response('OK');
}

export async function handleAdminRemove(request: Request, env: AppEnv): Promise<Response> {
	if (!(await requireLogin(request, env))) return unauthorized();
	const body = await parseBody(request);
	const url = String(body.url || '').trim();
	if (!url) return new Response('Bad Request', { status: 400 });
	await removeSource(env, url);
	return new Response('OK');
}

export async function handleAdminFilters(request: Request, env: AppEnv): Promise<Response> {
	if (!(await requireLogin(request, env))) return unauthorized();
	if (request.method === 'GET') return jsonResponse(await getSourceFilters(env));
	const body = await parseBody(request);
	const url = String(body.url || '').trim();
	if (!url) return new Response('Bad Request', { status: 400 });
	const sources = await listSources(env);
	if (!sources.includes(url)) return new Response('Not Found', { status: 404 });
	// types 以逗號分隔；空字串代表不過濾。
	const types = String(body.types || '').split(',').map((t) => t.trim()).filter(Boolean);
	await setSourceFilter(env, url, types);
	return new Response('OK');
}

export async function handleAdminConfigPost(request: Request, env: AppEnv): Promise<Response> {
	if (!(await requireLogin(request, env))) return unauthorized();
	const body = await parseBody(request);
	const n = Number(body.chunk_size);
	if (!Number.isInteger(n) || n < CHUNK_SIZE_MIN || n > CHUNK_SIZE_MAX) return new Response('Bad Request', { status: 400 });
	const base64Encode = body.base64_encode === '1' || body.base64_encode === 'true';
	// route 只接受已校驗的值，真正寫入 KV 交給 config service。
	await updateAdminConfig(env, n, base64Encode);
	return new Response('OK');
}

export async function handleRefresh(request: Request, env: AppEnv): Promise<Response> {
	if (!(await requireLogin(request, env))) return unauthorized();
	try {
		// 刷新是最重的路徑，route 不直接知道更新流程的內部細節。
		return jsonResponse(await refreshSubscriptions(env));
	} catch (e) {
		if (e instanceof RefreshInProgressError) {
			return jsonResponse({ error: 'refresh_in_progress', message: '上一次刷新還在進行中' }, 409);
		}
		// 內部錯誤細節只進 log，不回給用戶端。
		console.error('refresh_failed', e);
		return jsonResponse({ error: 'refresh_failed' }, 500);
	}
}

export async function handleDebug(request: Request, env: AppEnv): Promise<Response> {
	if (!(await requireLogin(request, env))) return unauthorized();
	const [sources, lastStats] = await Promise.all([
		listSources(env),
		env.KV_NAMESPACE.get(KV_KEYS.lastStats, { type: 'json' }),
	]);
	return new Response(JSON.stringify({ sources, status: 'ok', last_stats: lastStats }, null, 2), {
		headers: { 'content-type': 'application/json' },
	});
}
