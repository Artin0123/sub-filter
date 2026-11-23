import { describe, it, expect } from 'vitest';
import { classifySource, fetchSource, isBlockedHttpTarget } from '../src/fetchers';
import { safeBase64EncodeUtf8 } from '../src/subscription';

describe('source fetching', () => {
	it('classifies supported and unsupported source schemes', () => {
		expect(classifySource('https://example.com/sub')).toBe('http');
		expect(classifySource('HTTP://example.com/sub')).toBe('http');
		expect(classifySource('inline:vless://x')).toBe('inline');
		expect(classifySource('data:text/plain,abc')).toBe('data');
		expect(classifySource('ftp://example.com/sub')).toBeNull();
		expect(classifySource('file:///etc/passwd')).toBeNull();
		expect(classifySource('/relative/path')).toBeNull();
	});

	it('blocks private, loopback and reserved http targets', () => {
		const blocked = [
			'http://localhost/sub',
			'http://app.localhost/sub',
			'http://127.0.0.1/sub',
			'http://127.9.9.9/sub',
			'http://2130706433/sub', // 十進位形式的 127.0.0.1
			'http://0x7f.0.0.1/sub',
			'http://0/sub',
			'http://10.0.0.1/sub',
			'http://100.64.0.1/sub',
			'http://169.254.169.254/latest/meta-data/',
			'http://172.16.0.1/sub',
			'http://172.31.255.255/sub',
			'http://192.168.0.1/sub',
			'http://198.18.0.1/sub',
			'http://224.0.0.1/sub',
			'http://[::1]/sub',
			'http://[::]/sub',
			'http://[fc00::1]/sub',
			'http://[fe80::1]/sub',
			'http://[::ffff:192.168.1.1]/sub',
			'http://[64:ff9b::7f00:1]/sub', // NAT64 well-known prefix
			'http://[64:ff9b:1::1]/sub', // local-use NAT64
			'http://[2002:7f00:1::]/sub', // 6to4
			'http://metadata.google.internal/sub',
			'http://printer.local/sub',
			'not a url',
		];

		for (const url of blocked) {
			expect(isBlockedHttpTarget(url), url).toBe(true);
		}

		const allowed = [
			'https://example.com/sub',
			'http://1.1.1.1/sub',
			'http://8.8.8.8/sub',
			'https://[2001:4860:4860::8888]/sub',
			'http://172.32.0.1/sub',
			'http://11.0.0.1/sub',
		];

		for (const url of allowed) {
			expect(isBlockedHttpTarget(url), url).toBe(false);
		}
	});

	it('decodes data: sources, including UTF-8 payloads', async () => {
		const uri = 'vless://11111111-1111-1111-1111-111111111111@h.test:443?sni=h.test#節點一';

		const plain = await fetchSource('data:text/plain,' + encodeURIComponent(uri));
		expect(plain.ok).toBe(true);
		expect(plain.text).toBe(uri);

		// base64 分支必須做 UTF-8 解碼，不能退回 latin-1 造成節點名稱亂碼
		const base64 = await fetchSource('data:text/plain;base64,' + safeBase64EncodeUtf8(uri));
		expect(base64.ok).toBe(true);
		expect(base64.text).toBe(uri);
	});

	it('rejects malformed data: urls instead of parsing the metadata as content', async () => {
		const res = await fetchSource('data:text/plain;base64');
		expect(res.ok).toBe(false);
		expect(res.error).toBe('invalid_data_url');

		const badPercent = await fetchSource('data:text/plain,%E0%A4%A');
		expect(badPercent.ok).toBe(false);
		expect(badPercent.error).toBe('invalid_data_url');
	});

	it('never falls through to fetch() for unsupported schemes or blocked hosts', async () => {
		const unsupported = await fetchSource('file:///etc/passwd');
		expect(unsupported.ok).toBe(false);
		expect(unsupported.status).toBe(0);
		expect(unsupported.error).toBe('unsupported_scheme');

		const blocked = await fetchSource('http://169.254.169.254/latest/meta-data/');
		expect(blocked.ok).toBe(false);
		expect(blocked.status).toBe(0);
		expect(blocked.error).toBe('blocked_host');
	});

	it('returns inline: content as-is', async () => {
		const res = await fetchSource('inline:first\nsecond');
		expect(res.ok).toBe(true);
		expect(res.text).toBe('first\nsecond');
	});
});
