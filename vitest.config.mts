import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: './src/index.ts',
			wrangler: { configPath: './.local/wrangler.toml', environment: 'production' },
			miniflare: {
				bindings: {
					ADMIN_PASSWORD: 'test-admin-password',
				},
			},
		}),
	],
});
