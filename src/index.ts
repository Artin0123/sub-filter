/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { KV_KEYS } from './kv';
import { cacheGet, cachePut, withCacheControl } from './cache';
import { signCookie, verifyCookie } from './auth';
import { runUpdate } from './update';

function html(body: string, noCache = false): Response {
	const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
	if (noCache) headers.set('Cache-Control', 'no-store');
	return new Response(`<!doctype html><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>${body}`, { headers });
}

function getCookie(req: Request, name: string): string | null {
	const raw = req.headers.get('cookie');
	if (!raw) return null;
	const parts = raw.split(/;\s*/);
	for (const p of parts) {
		const [k, v] = p.split('=');
		if (k === name) return decodeURIComponent(v ?? '');
	}
	return null;
}

function setSessionCookie(token: string, maxAgeSec = 24 * 60 * 60): string {
	const expires = new Date(Date.now() + maxAgeSec * 1000).toUTCString();
	return `session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires}`;
}

function clearSessionCookie(): string {
	const expires = new Date(0).toUTCString();
	return `session=; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires}`;
}

async function requireLogin(req: Request, env: Env): Promise<boolean> {
	const cookie = getCookie(req, 'session');
	if (!cookie) return false;
	const secret = env.ADMIN_PASSWORD;
	if (!secret || typeof secret !== 'string' || secret.length === 0) return false;
	try {
		const payload = await verifyCookie(secret, cookie);
		return !!payload;
	} catch {
		return false;
	}
}

// Removed: /sub.txt endpoint (full output kept internal in KV)

async function handleSubChunk(request: Request, env: Env, index: number): Promise<Response> {
	const totalStr = await env.KV_NAMESPACE.get(KV_KEYS.chunksTotal);
	const total = totalStr ? parseInt(totalStr, 10) : 0;
	if (!(index >= 1 && index <= total)) return new Response('Not Found', { status: 404 });

	const ifNone = request.headers.get('if-none-match');
	const etag = await env.KV_NAMESPACE.get(KV_KEYS.etagI(index));
	if (etag && ifNone && ifNone === etag) {
		return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'public, max-age=300, must-revalidate' } });
	}

	const cached = await cacheGet(request);
	if (cached) return cached;

	const body = await env.KV_NAMESPACE.get(KV_KEYS.subTxtI(index));
	if (!body) return new Response('Not Found', { status: 404 });

	const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
	if (etag) headers.set('ETag', etag);
	let res = new Response(body, { headers });
	res = withCacheControl(res);
	await cachePut(request, res.clone());
	return res;
}

async function handleAdminPage(request: Request, env: Env): Promise<Response> {
	const loggedIn = await requireLogin(request, env);
	if (!loggedIn) {
		return html(`
			<style>
				body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:800px;margin:40px auto;padding:0 16px}
				.card{border:1px solid #ddd;border-radius:8px;padding:16px}
				.row{display:flex;gap:8px}
				input[type=password]{flex:1;padding:8px}
				button{padding:8px 12px}
			</style>
			<h1>Admin Login</h1>
			<div class="card">
				<form id="login-form" class="row">
					<input type="password" name="password" placeholder="Password" required />
					<button type="submit">Login</button>
				</form>
				<div id="msg" style="margin-top:8px;color:#c00"></div>
			</div>
			<script>
			const form = document.getElementById('login-form');
			form.addEventListener('submit', async (e)=>{
				e.preventDefault();
				const fd = new FormData(form);
				const body = new URLSearchParams(fd);
				const r = await fetch('/login', { method:'POST', body });
				if(r.ok){ location.href='/'; }
				else{ document.getElementById('msg').textContent = 'Login failed'; }
			});
			</script>
		`, true);
	}
	return html(`
		<style>
			*, *::before, *::after{box-sizing:border-box}
			body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:900px;margin:40px auto;padding:0 16px}
			.grid{display:grid;grid-template-columns:1fr;gap:16px}
			.card{border:1px solid #ddd;border-radius:8px;padding:16px;max-width:100%;}
			.row{display:flex;gap:8px;align-items:center}
			input[type=text],input[type=number]{flex:1;padding:8px}
			button{padding:8px 12px}
			ul{margin:0;padding-left:18px;max-height:280px;overflow:auto}
			ul li a{display:inline-block;max-width:100%;overflow-wrap:anywhere;word-break:break-all}
			code{background:#f6f8fa;padding:1px 4px;border-radius:4px}
		</style>
		<h1>Admin Console</h1>
		<div class="row" style="margin-bottom:12px">
			<form id="logout-form"><button type="submit">Logout</button></form>
			<button id="refresh">Refresh Now</button>
			<span id="status" style="margin-left:8px;color:#555"></span>
		</div>
		<div class="grid">
			<div class="card">
				<h3>Sources</h3>
				<div class="row" style="margin-bottom:8px">
					<input type="text" id="source-input" placeholder="Source URL (supports inline:..., data:...)" />
					<button id="add">Add</button>
				</div>
				<ul id="sources"></ul>
			</div>
			<div class="card">
				<h3>Config</h3>
				<div class="row" style="margin-bottom:8px">
					<label>chunk_size</label>
					<input type="number" id="chunk-size" min="50" max="2000" step="1" />
					<button id="save-cfg">Save</button>
				</div>
				<div id="cfg-msg" style="color:#0a0"></div>
				<div style="margin-top:8px;color:#555">Use <code>inline:</code> to paste subscription content directly for testing.</div>
			</div>
		</div>
		<script>
		async function loadList(){
			const r = await fetch('/list');
			const arr = await r.json();
			const ul = document.getElementById('sources');
			ul.innerHTML='';
			arr.forEach(u=>{
				const li = document.createElement('li');
				const a = document.createElement('a'); a.href=u; a.textContent=u; a.target='_blank';
				const btn = document.createElement('button'); btn.textContent='Remove'; btn.style.marginLeft='8px';
				btn.addEventListener('click', async ()=>{
					const body = new URLSearchParams({ url: u });
					const rr = await fetch('/remove', { method:'POST', body });
					if(rr.ok) loadList();
				});
				li.append(a, btn); ul.append(li);
			});
		}
		async function loadConfig(){
			const r = await fetch('/config');
			const cfg = await r.json();
			document.getElementById('chunk-size').value = cfg.chunk_size ?? 400;
		}
		document.getElementById('add').addEventListener('click', async ()=>{
			const url = document.getElementById('source-input').value.trim();
			if(!url) return;
			const body = new URLSearchParams({ url });
			const r = await fetch('/add', { method:'POST', body });
			if(r.ok){ document.getElementById('source-input').value=''; loadList(); }
		});
		document.getElementById('save-cfg').addEventListener('click', async ()=>{
			const n = document.getElementById('chunk-size').value;
			const body = new URLSearchParams({ chunk_size: n });
			const r = await fetch('/config', { method:'POST', body });
			document.getElementById('cfg-msg').textContent = r.ok ? 'Saved' : 'Failed';
			setTimeout(()=>{document.getElementById('cfg-msg').textContent='';},1500);
		});
		document.getElementById('logout-form').addEventListener('submit', async (e)=>{
			e.preventDefault();
			await fetch('/logout', { method:'POST' });
			location.href='/';
		});
		document.getElementById('refresh').addEventListener('click', async ()=>{
			const s = document.getElementById('status'); s.textContent='Refreshing...';
			const r = await fetch('/refresh', { method:'POST' });
			const j = await r.json().catch(()=>({}));
			const parts = [];
			if (r.ok) {
			  parts.push('Updated: ' + (j.updated));
			  parts.push('records=' + (j.records));
			  if (j && j.chunks) parts.push('chunks=' + (j.chunks.total) + ' (size=' + (j.chunks.size) + ')');
			  if (j && j.perSource) parts.push('sources ok=' + j.perSource.ok + ', fail=' + j.perSource.fail);
			  s.textContent = parts.join(', ');
			} else {
			  s.textContent = 'Failed' + (j && (j.message || j.error) ? (': ' + (j.message || j.error)) : '');
			}
			setTimeout(()=>{s.textContent='';}, 4000);
		});
		loadList(); loadConfig();
		</script>
	`, true);
}

async function parseBody(req: Request): Promise<Record<string, any>> {
	const ct = req.headers.get('content-type') || '';
	try {
		if (ct.includes('application/json')) return await req.json();
	} catch { }
	if (ct.includes('application/x-www-form-urlencoded')) {
		const form = await req.formData();
		const obj: Record<string, any> = {};
		for (const [k, v] of form.entries()) obj[k] = typeof v === 'string' ? v : String(v);
		return obj;
	}
	// Fallback: try text -> parse key=value
	const text = await req.text();
	const params = new URLSearchParams(text);
	const obj: Record<string, any> = {};
	for (const [k, v] of params.entries()) obj[k] = v;
	return obj;
}

async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
	const body = await parseBody(request);
	if (!env.ADMIN_PASSWORD) {
		return new Response('ADMIN_PASSWORD not configured', { status: 500 });
	}
	const ok = typeof body.password === 'string' && body.password === env.ADMIN_PASSWORD;
	if (!ok) return new Response('Unauthorized', { status: 401 });
	const token = await signCookie(env.ADMIN_PASSWORD, { sub: 'admin', exp: Math.floor(Date.now() / 1000) + 86400 });
	return new Response('OK', {
		headers: { 'set-cookie': setSessionCookie(token) },
	});
}

async function handleAdminLogout(): Promise<Response> {
	return new Response('OK', {
		headers: { 'set-cookie': clearSessionCookie() },
	});
}

async function ensureAuth(request: Request, env: Env): Promise<Response | null> {
	const ok = await requireLogin(request, env);
	if (!ok) return new Response('Unauthorized', { status: 401 });
	return null;
}

async function handleAdminList(request: Request, env: Env): Promise<Response> {
	const unauth = await ensureAuth(request, env); if (unauth) return unauth;
	const sources = (await env.KV_NAMESPACE.get(KV_KEYS.sources, { type: 'json' })) as string[] | null;
	return new Response(JSON.stringify(sources ?? []), { headers: { 'content-type': 'application/json' } });
}

async function handleAdminAdd(request: Request, env: Env): Promise<Response> {
	const unauth = await ensureAuth(request, env); if (unauth) return unauth;
	const body = await parseBody(request);
	const url = String(body.url || '').trim();
	if (!url) return new Response('Bad Request', { status: 400 });
	const sources = ((await env.KV_NAMESPACE.get(KV_KEYS.sources, { type: 'json' })) as string[] | null) ?? [];
	if (!sources.includes(url)) sources.push(url);
	await env.KV_NAMESPACE.put(KV_KEYS.sources, JSON.stringify(sources));
	return new Response('OK');
}

async function handleAdminRemove(request: Request, env: Env): Promise<Response> {
	const unauth = await ensureAuth(request, env); if (unauth) return unauth;
	const body = await parseBody(request);
	const url = String(body.url || '').trim();
	if (!url) return new Response('Bad Request', { status: 400 });
	const sources = ((await env.KV_NAMESPACE.get(KV_KEYS.sources, { type: 'json' })) as string[] | null) ?? [];
	const next = sources.filter((s) => s !== url);
	await env.KV_NAMESPACE.put(KV_KEYS.sources, JSON.stringify(next));
	return new Response('OK');
}

async function handleAdminConfigGet(request: Request, env: Env): Promise<Response> {
	const unauth = await ensureAuth(request, env); if (unauth) return unauth;
	const chunkSizeStr = await env.KV_NAMESPACE.get(KV_KEYS.chunkSize);
	const chunk_size = chunkSizeStr ? parseInt(chunkSizeStr, 10) : 400;
	return new Response(JSON.stringify({ chunk_size }), { headers: { 'content-type': 'application/json' } });
}

async function handleAdminConfigPost(request: Request, env: Env): Promise<Response> {
	const unauth = await ensureAuth(request, env); if (unauth) return unauth;
	const body = await parseBody(request);
	const n = Number(body.chunk_size);
	if (!Number.isInteger(n) || n < 50 || n > 2000) return new Response('Bad Request', { status: 400 });
	await env.KV_NAMESPACE.put(KV_KEYS.chunkSize, String(n));
	return new Response('OK');
}

async function handleRefresh(request: Request, env: Env): Promise<Response> {
	// auth: prefer Bearer first (avoids stale cookies interfering), then cookie
	let ok = false;
	const auth = request.headers.get('authorization');
	if (auth && auth.startsWith('Bearer ')) {
		const token = auth.split(' ')[1] ?? '';
		ok = token === env.ADMIN_PASSWORD;
	}
	if (!ok) {
		ok = await requireLogin(request, env);
	}
	if (!ok) return new Response('Unauthorized', { status: 401 });

	// Basic binding sanity checks
	if (!env.KV_NAMESPACE || typeof (env.KV_NAMESPACE as any).get !== 'function') {
		return new Response(JSON.stringify({ error: 'kv_binding_missing', message: 'KV_NAMESPACE binding is missing or invalid' }), { status: 500, headers: { 'content-type': 'application/json' } });
	}
	try {
		const result = await runUpdate(env);
		return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
	} catch (e: any) {
		console.error('refresh failed', e);
		return new Response(JSON.stringify({ error: 'refresh_failed', message: String(e) }), { status: 500, headers: { 'content-type': 'application/json' } });
	}
}

async function handleDebug(request: Request, env: Env): Promise<Response> {
	const unauth = await ensureAuth(request, env); if (unauth) return unauth;
	const chunkSizeStr = await env.KV_NAMESPACE.get(KV_KEYS.chunkSize);
	const sources = (await env.KV_NAMESPACE.get(KV_KEYS.sources, { type: 'json' })) as string[] | null;
	const chunkSizeEffective = chunkSizeStr ? parseInt(chunkSizeStr, 10) : 400;
	const lastStats = await env.KV_NAMESPACE.get(KV_KEYS.lastStats, { type: 'json' }) as any | null;
	const info: any = {
		kvBindingType: typeof (env.KV_NAMESPACE as any),
		hasGet: typeof (env.KV_NAMESPACE as any)?.get === 'function',
		chunk_size_raw: chunkSizeStr,
		chunk_size_effective: chunkSizeEffective,
		sources_count: Array.isArray(sources) ? sources.length : 0,
		sources: Array.isArray(sources) ? sources : [],
		sources_contains_gist: Array.isArray(sources) ? sources.some(s => s.includes('gist.githubusercontent.com')) : false,
		last_stats: lastStats || undefined,
	};
	return new Response(JSON.stringify(info, null, 2), { headers: { 'content-type': 'application/json' } });
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname;

		// Public subscription endpoints (chunked only)
		const m = pathname.match(/^\/sub_(\d+)\.txt$/);
		if (request.method === 'GET' && m) {
			const idx = parseInt(m[1], 10);
			return handleSubChunk(request, env, idx);
		}

		// Admin UI and APIs (moved to root)
		if (request.method === 'GET' && pathname === '/') return handleAdminPage(request, env);
		if (request.method === 'POST' && pathname === '/login') return handleAdminLogin(request, env);
		if (request.method === 'POST' && pathname === '/logout') return handleAdminLogout();
		if (request.method === 'GET' && pathname === '/list') return handleAdminList(request, env);
		if (request.method === 'POST' && pathname === '/add') return handleAdminAdd(request, env);
		if (request.method === 'POST' && pathname === '/remove') return handleAdminRemove(request, env);
		if (request.method === 'GET' && pathname === '/config') return handleAdminConfigGet(request, env);
		if (request.method === 'POST' && pathname === '/config') return handleAdminConfigPost(request, env);
		if (request.method === 'GET' && pathname === '/debug') return handleDebug(request, env);

		// Refresh hook
		if (request.method === 'POST' && pathname === '/refresh') return handleRefresh(request, env);

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
