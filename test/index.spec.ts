import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Root admin page', () => {
	it('responds with Admin Login when not authenticated', async () => {
		const response = await SELF.fetch('https://example.com/');
		const txt = await response.text();
		expect(txt).toMatch(/Admin Login/);
	});
});
