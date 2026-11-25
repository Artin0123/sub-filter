// 管理後台前端邏輯。
// 這裡統一處理 401 跳回登入頁，避免 session 過期後各按鈕靜默失敗。
const THEME_LABELS = {
	// Show the icon for the *target* theme (same behavior as the old "Dark/Light" labels).
	light: '🌙',
	dark: '☀️',
};

// 與 src/services/source-store.ts 的 MAX_SOURCE_URL_LENGTH 保持一致。
const MAX_SOURCE_URL_LENGTH = 4096;
// 後台只接受這幾種來源格式；不符的直接不給連結，避免把 javascript: 之類的輸入渲染成可點元素。
const SOURCE_URL_PATTERN = /^(https?:\/\/|inline:)/i;

function redirectToLogin() {
	location.href = '/login-page.html';
}

const themeBtn = document.getElementById('theme-toggle');

function setThemeButtonLabel(isDark) {
	themeBtn.textContent = isDark ? THEME_LABELS.dark : THEME_LABELS.light;
	themeBtn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
}

const theme = localStorage.getItem('theme') || 'light';
if (theme === 'dark') document.body.classList.add('dark');
setThemeButtonLabel(theme === 'dark');
themeBtn.addEventListener('click', () => {
	const isDark = document.body.classList.toggle('dark');
	localStorage.setItem('theme', isDark ? 'dark' : 'light');
	setThemeButtonLabel(isDark);
});

let currentChunk = 1;
let totalChunks = 1;
let subToken = '';

function updateChunkNav() {
	const prevBtn = document.getElementById('prev-chunk');
	const nextBtn = document.getElementById('next-chunk');
	const copyBtn = document.getElementById('copy-url');
	prevBtn.disabled = currentChunk <= 1;
	nextBtn.disabled = currentChunk >= totalChunks;
	copyBtn.textContent = 'Copy sub_' + currentChunk + ' link';
}

document.getElementById('prev-chunk').addEventListener('click', () => {
	if (currentChunk > 1) {
		currentChunk--;
		updateChunkNav();
	}
});

document.getElementById('next-chunk').addEventListener('click', () => {
	if (currentChunk < totalChunks) {
		currentChunk++;
		updateChunkNav();
	}
});

document.getElementById('copy-url').addEventListener('click', async () => {
	const url = location.origin + '/sub_' + currentChunk + '?token=' + encodeURIComponent(subToken);
	const msg = document.getElementById('copy-msg');
	try {
		await navigator.clipboard.writeText(url);
		msg.textContent = 'URL copied!';
		msg.style.color = '#0a0';
	} catch {
		msg.textContent = 'Copy failed, please copy manually: ' + url;
		msg.style.color = '#c00';
	}
	setTimeout(() => {
		msg.textContent = '';
	}, 2000);
});

const PROTOCOLS = ['vmess', 'vless', 'trojan', 'ss', 'hysteria2'];

// 置中浮動視窗：勾選要保留的協議；全不勾 = 不過濾。
function openFilterDialog(url, current) {
	const overlay = document.createElement('div');
	overlay.className = 'modal-overlay';
	const dialog = document.createElement('div');
	dialog.className = 'modal card';

	const title = document.createElement('h3');
	title.className = 'modal-title';
	title.textContent = '協議過濾';
	const hint = document.createElement('div');
	hint.className = 'modal-hint';
	hint.textContent = '只保留勾選的格式；全部不勾則不過濾。重新整理後生效。';
	dialog.append(title, hint);

	const boxes = PROTOCOLS.map((p) => {
		const label = document.createElement('label');
		label.className = 'modal-option';
		const cb = document.createElement('input');
		cb.type = 'checkbox';
		cb.value = p;
		cb.checked = current.includes(p);
		label.append(cb, document.createTextNode(' ' + p));
		dialog.append(label);
		return cb;
	});

	const onKeydown = (e) => {
		if (e.key === 'Escape') close();
	};
	const close = () => {
		document.removeEventListener('keydown', onKeydown);
		overlay.remove();
	};
	document.addEventListener('keydown', onKeydown);
	const actions = document.createElement('div');
	actions.className = 'modal-actions';
	const save = document.createElement('button');
	save.textContent = 'Save';
	const cancel = document.createElement('button');
	cancel.textContent = 'Cancel';
	cancel.addEventListener('click', close);
	save.addEventListener('click', async () => {
		save.disabled = true;
		const types = boxes.filter((b) => b.checked).map((b) => b.value).join(',');
		const r = await fetch('/filters', { method: 'POST', body: new URLSearchParams({ url, types }) });
		if (r.status === 401) {
			redirectToLogin();
			return;
		}
		if (!r.ok) {
			save.disabled = false;
			alert('儲存失敗 (HTTP ' + r.status + ')');
			return;
		}
		close();
		loadList();
	});
	actions.append(cancel, save);
	dialog.append(actions);

	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) close();
	});
	overlay.append(dialog);
	document.body.append(overlay);
}

async function loadList() {
	const [r, fr] = await Promise.all([fetch('/list'), fetch('/filters')]);
	if (r.status === 401 || fr.status === 401) {
		redirectToLogin();
		return;
	}
	if (!r.ok) {
		document.getElementById('source-msg').textContent = 'Failed to load sources (HTTP ' + r.status + ')';
		return;
	}
	const arr = await r.json();
	// 讀不到過濾設定時直接報錯，不要讓按鈕假裝「沒有過濾」。
	if (!fr.ok) {
		document.getElementById('source-msg').textContent = 'Failed to load filters (HTTP ' + fr.status + ')';
		return;
	}
	const filters = await fr.json();
	const ul = document.getElementById('sources');
	ul.innerHTML = '';
	arr.forEach((u) => {
		const li = document.createElement('li');
		li.className = 'source-item';

		const content = document.createElement('div');
		content.className = 'source-content';

		if (SOURCE_URL_PATTERN.test(u)) {
			const a = document.createElement('a');
			a.href = u;
			a.textContent = u;
			a.title = u;
			a.target = '_blank';
			a.rel = 'noopener noreferrer';
			a.className = 'source-link';
			content.append(a);
		} else {
			const span = document.createElement('span');
			span.textContent = u;
			span.title = u;
			span.className = 'source-link';
			content.append(span);
		}

		const filterBtn = document.createElement('button');
		const active = filters[u] || [];
		filterBtn.textContent = active.length ? 'Filter (' + active.length + ')' : 'Filter';
		filterBtn.title = active.length ? 'Only keep: ' + active.join(', ') : 'No filter';
		filterBtn.className = 'source-btn';
		filterBtn.addEventListener('click', () => openFilterDialog(u, active));

		const btn = document.createElement('button');
		btn.textContent = 'Remove';
		btn.className = 'source-btn';
		btn.addEventListener('click', async () => {
			// 瀏覽器的 confirm 對過長文字會自行截斷，這裡先自行以 ... 省略。
			const shown = u.length > 80 ? u.slice(0, 80) + '...' : u;
			if (!confirm('確定要刪除此來源嗎？\n\n' + shown)) return;
			const body = new URLSearchParams({ url: u });
			const rr = await fetch('/remove', { method: 'POST', body });
			if (rr.status === 401) {
				redirectToLogin();
				return;
			}
			if (rr.ok) loadList();
		});

		const actions = document.createElement('div');
		actions.className = 'source-actions';
		actions.append(filterBtn, btn);
		content.append(actions);
		li.append(content);
		ul.append(li);
	});
}

async function loadConfig() {
	const r = await fetch('/config');
	if (r.status === 401) {
		redirectToLogin();
		return;
	}
	if (!r.ok) {
		document.getElementById('cfg-msg').textContent = 'Failed to load config (HTTP ' + r.status + ')';
		return;
	}
	const cfg = await r.json();
	document.getElementById('chunk-size').value = cfg.chunk_size ?? 400;
	document.getElementById('base64-encode').checked = cfg.base64_encode ?? false;
	subToken = cfg.subscription_token || '';
	// 分塊數量直接由 /config 提供，不需要再繞去 /debug 讀統計資料。
	totalChunks = Math.max(1, Number(cfg.chunks_total || 0));
	updateChunkNav();
}

document.getElementById('debug-btn').addEventListener('click', () => {
	location.href = '/debug';
});

document.getElementById('add').addEventListener('click', async () => {
	const url = document.getElementById('source-input').value.trim();
	if (!url) return;
	const msg = document.getElementById('source-msg');
	if (url.length > MAX_SOURCE_URL_LENGTH) {
		msg.textContent = '来源地址过长（上限 ' + MAX_SOURCE_URL_LENGTH + ' 字符）';
		return;
	}
	msg.textContent = '';
	const body = new URLSearchParams({ url });
	const r = await fetch('/add', { method: 'POST', body });
	if (r.status === 401) {
		redirectToLogin();
		return;
	}
	if (r.ok) {
		document.getElementById('source-input').value = '';
		msg.textContent = '';
		loadList();
		return;
	}
	const j = await r.json().catch(() => ({}));
	msg.textContent = j && (j.message || j.error) ? (j.message || j.error) : 'Failed';
});

document.getElementById('save-cfg').addEventListener('click', async () => {
	const n = document.getElementById('chunk-size').value;
	const base64 = document.getElementById('base64-encode').checked;

	const body = new URLSearchParams({
		chunk_size: n,
		base64_encode: base64 ? '1' : '0',
	});
	const r = await fetch('/config', { method: 'POST', body });
	if (r.status === 401) {
		redirectToLogin();
		return;
	}
	document.getElementById('cfg-msg').textContent = r.ok ? 'Saved' : 'Failed';
	setTimeout(() => {
		document.getElementById('cfg-msg').textContent = '';
	}, 1500);
});

document.getElementById('logout-form').addEventListener('submit', async (e) => {
	e.preventDefault();
	await fetch('/logout', { method: 'POST' });
	location.href = '/';
});

document.getElementById('refresh').addEventListener('click', async () => {
	const s = document.getElementById('status');
	s.textContent = 'Refreshing...';
	const r = await fetch('/refresh', { method: 'POST' });
	if (r.status === 401) {
		redirectToLogin();
		return;
	}
	const j = await r.json().catch(() => ({}));
	if (r.ok) {
		const parts = ['Updated: ' + j.updated, 'records=' + j.records];
		if (j && j.chunks) {
			parts.push('chunks=' + j.chunks.total + ' (size=' + j.chunks.size + ')');
			totalChunks = Math.max(1, Number(j.chunks.total || 0));
			currentChunk = Math.min(currentChunk, totalChunks);
			updateChunkNav();
		}
		if (j && j.perSource) parts.push('sources ok=' + j.perSource.ok + ', fail=' + j.perSource.fail);
		s.textContent = parts.join(', ');
	} else if (r.status === 409) {
		s.textContent = 'Refresh already in progress';
	} else {
		s.textContent = 'Failed' + (j && (j.message || j.error) ? ': ' + (j.message || j.error) : '');
	}
	setTimeout(() => {
		s.textContent = '';
	}, 4000);
});

loadList();
loadConfig();
