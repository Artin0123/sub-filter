// Source fetchers with timeout and single retry

export type FetchResult = { url: string; ok: boolean; status: number; text?: string; error?: string };

export async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
    const ac = new AbortController();
    const id = setTimeout(() => ac.abort("timeout"), ms);
    try {
        return await fetch(url, { signal: ac.signal });
    } finally {
        clearTimeout(id);
    }
}

export async function fetchOnce(url: string, timeoutMs = 10000): Promise<FetchResult> {
    try {
        const res = await fetchWithTimeout(url, timeoutMs);
        const text = await res.text();
        return { url, ok: res.ok, status: res.status, text };
    } catch (e) {
        return { url, ok: false, status: 0, error: String(e) };
    }
}

export async function fetchWithRetry(url: string, timeoutMs = 10000): Promise<FetchResult> {
    const first = await fetchOnce(url, timeoutMs);
    if (first.ok) return first;
    // simple backoff
    await new Promise((r) => setTimeout(r, 300));
    const second = await fetchOnce(url, timeoutMs);
    return second;
}
