import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Admin panel', () => {
    it('login -> admin page -> list/add/remove/config -> refresh', async () => {
        // not logged in page contains login heading
        const r0 = await SELF.fetch('https://example.com/');
        expect(r0.status).toBe(200);
        const html = await r0.text();
        expect(html).toMatch(/Admin Login/);

        // login
        const login = await SELF.fetch('https://example.com/login', {
            method: 'POST',
            body: new URLSearchParams({ password: env.ADMIN_PASSWORD }),
        });
        expect(login.status).toBe(200);
        const cookie = login.headers.get('set-cookie');
        expect(cookie).toBeTruthy();

        // admin page while logged in
        const r1 = await SELF.fetch('https://example.com/', { headers: { cookie: cookie! } });
        expect(r1.status).toBe(200);
        const html2 = await r1.text();
        expect(html2).toMatch(/Admin Console/);

        // list
        const r2 = await SELF.fetch('https://example.com/list', { headers: { cookie: cookie! } });
        expect(r2.status).toBe(200);
        const arr = await r2.json();
        expect(Array.isArray(arr)).toBe(true);

        // add
        const inline = 'inline:vless://11111111-1111-1111-1111-111111111111@h1.t:443?sni=h1.t#v1';
        const add = await SELF.fetch('https://example.com/add', { method: 'POST', headers: { cookie: cookie! }, body: new URLSearchParams({ url: inline }) });
        expect(add.status).toBe(200);

        // list again contains inline
        const r3 = await SELF.fetch('https://example.com/list', { headers: { cookie: cookie! } });
        const arr2 = await r3.json();
        expect(arr2).toContain(inline);

        // config get
        const cfg = await SELF.fetch('https://example.com/config', { headers: { cookie: cookie! } });
        expect(cfg.status).toBe(200);
        const jcfg = await cfg.json() as any;
        expect(typeof jcfg.chunk_size).toBe('number');

        // update config
        const save = await SELF.fetch('https://example.com/config', { method: 'POST', headers: { cookie: cookie! }, body: new URLSearchParams({ chunk_size: '300' }) });
        expect(save.status).toBe(200);

        // trigger refresh (cookie auth)
        const ref = await SELF.fetch('https://example.com/refresh', { method: 'POST', headers: { cookie: cookie! } });
        expect(ref.status).toBe(200);
    });
});
