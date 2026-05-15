import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: './src/index.ts',
			// Keep tests self-contained; `.local/` is an optional local snapshot and not available in CI/clean clones.
			wrangler: { configPath: './wrangler.vitest.toml', environment: 'production' },
			miniflare: {
				bindings: {
					ADMIN_PASSWORD: 'test-admin-password',
				},
			},
		}),
	],
});
