import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Root admin page', () => {
	it('responds with Admin Login when not authenticated', async () => {
		const response = await SELF.fetch('https://example.com/', { redirect: 'manual' });
		expect(response.status).toBe(302);
		expect(response.headers.get('Location')).toContain('/login-page.html');
	});
});
