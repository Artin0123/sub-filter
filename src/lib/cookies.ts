/**
 * 讀取指定 cookie。
 * 管理介面的 session 目前只靠這裡統一解析，避免各 handler 自己拆字串。
 */
export function getCookie(req: Request, name: string): string | null {
	const raw = req.headers.get('cookie');
	if (!raw) return null;
	const parts = raw.split(/;\s*/);
	for (const part of parts) {
		const [key, value] = part.split('=');
		if (key === name) return decodeURIComponent(value ?? '');
	}
	return null;
}

export function setSessionCookie(token: string, maxAgeSec = 24 * 60 * 60): string {
	const expires = new Date(Date.now() + maxAgeSec * 1000).toUTCString();
	return `session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires}`;
}

export function clearSessionCookie(): string {
	const expires = new Date(0).toUTCString();
	return `session=; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires}`;
}
