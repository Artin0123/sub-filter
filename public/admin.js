// Dark mode
const theme = localStorage.getItem('theme') || 'light';
if (theme === 'dark') document.body.classList.add('dark');
const themeBtn = document.getElementById('theme-toggle');
themeBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
themeBtn.addEventListener('click', () => {
    const isDark = document.body.classList.toggle('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    themeBtn.textContent = isDark ? '☀️' : '🌙';
});

// Chunk navigation
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
    const url = location.origin + '/sub_' + currentChunk + '?token=' + subToken;
    await navigator.clipboard.writeText(url);
    const msg = document.getElementById('copy-msg');
    msg.textContent = 'URL copied!';
    msg.style.color = '#0a0';
    setTimeout(() => {
        msg.textContent = '';
    }, 2000);
});

async function loadList() {
    const r = await fetch('/list');
    const arr = await r.json();
    const ul = document.getElementById('sources');
    ul.innerHTML = '';
    arr.forEach((u) => {
        const li = document.createElement('li');
        li.className = 'source-item';

        const a = document.createElement('a');
        a.href = u;
        a.textContent = u;
        a.target = '_blank';
        a.className = 'source-link';

        const btn = document.createElement('button');
        btn.textContent = 'Remove';
        btn.className = 'remove-btn';
        btn.addEventListener('click', async () => {
            const body = new URLSearchParams({ url: u });
            const rr = await fetch('/remove', { method: 'POST', body });
            if (rr.ok) loadList();
        });

        const content = document.createElement('div');
        content.className = 'source-content';
        content.append(a, btn);

        li.append(content);
        ul.append(li);
    });
}

async function loadConfig() {
    const r = await fetch('/config');
    const cfg = await r.json();
    document.getElementById('chunk-size').value = cfg.chunk_size ?? 400;
    document.getElementById('base64-encode').checked = cfg.base64_encode ?? false;
    subToken = cfg.subscription_token || '';
}

async function loadChunksTotal() {
    try {
        const r = await fetch('/debug');
        if (r.ok) {
            const data = await r.json();
            totalChunks = Math.max(1, parseInt(data.last_stats?.chunkLineCounts?.length || 1));
        }
    } catch (e) { }
    updateChunkNav();
}

document.getElementById('debug-btn').addEventListener('click', () => {
    location.href = '/debug';
});

document.getElementById('add').addEventListener('click', async () => {
    const url = document.getElementById('source-input').value.trim();
    if (!url) return;
    const body = new URLSearchParams({ url });
    const r = await fetch('/add', { method: 'POST', body });
    if (r.ok) {
        document.getElementById('source-input').value = '';
        loadList();
    }
});

document.getElementById('save-cfg').addEventListener('click', async () => {
    const n = document.getElementById('chunk-size').value;
    const base64 = document.getElementById('base64-encode').checked;

    const body = new URLSearchParams({
        chunk_size: n,
        base64_encode: base64 ? '1' : '0'
    });
    const r = await fetch('/config', { method: 'POST', body });
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
    const j = (await r.json().catch(() => ({})));
    const parts = [];
    if (r.ok) {
        parts.push('Updated: ' + j.updated);
        parts.push('records=' + j.records);
        if (j && j.chunks) {
            parts.push('chunks=' + j.chunks.total + ' (size=' + j.chunks.size + ')');
            totalChunks = j.chunks.total || 1;
            updateChunkNav();
        }
        if (j && j.perSource) parts.push('sources ok=' + j.perSource.ok + ', fail=' + j.perSource.fail);
        s.textContent = parts.join(', ');
    } else {
        s.textContent = 'Failed' + (j && (j.message || j.error) ? ': ' + (j.message || j.error) : '');
    }
    setTimeout(() => {
        s.textContent = '';
    }, 4000);
});

loadList();
loadConfig();
loadChunksTotal();
