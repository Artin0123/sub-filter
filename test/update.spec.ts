import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const inlineBody = [
    'vless://11111111-1111-1111-1111-111111111111@example.com:443?sni=example.com#vl1',
    'trojan://pass@example.com:443?sni=example.com#tr1',
    'vmess://' + btoa(JSON.stringify({ add: 'example.com', port: 443, id: '22222222-2222-2222-2222-222222222222', sni: 'example.com', tls: 'tls', ps: 'vm1' })),
].join('\n');

async function generateToken(password: string): Promise<string> {
    const data = new TextEncoder().encode(password);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex.substring(0, 16);
}

async function generateBearerToken(password: string): Promise<string> {
    // Generate HMAC-signed token (same as signCookie in auth.ts)
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const payload = { sub: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 };
    const body = encoder.encode(JSON.stringify(payload));
    const sig = await crypto.subtle.sign({ name: 'HMAC' }, key, body);

    // Base64url encode
    const toBase64Url = (data: ArrayBuffer | Uint8Array): string => {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        let str = '';
        for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
        return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    };

    return `${toBase64Url(body)}.${toBase64Url(sig)}`;
}

describe('Refresh update flow (inline source)', () => {
    it('updates KV and serves chunk endpoints', async () => {
        // Seed KV
        await env.KV_NAMESPACE.put('sources', JSON.stringify([`inline:${inlineBody}`]));
        await env.KV_NAMESPACE.put('chunk_size', '2');

        // Trigger refresh via Bearer
        const bearerToken = await generateBearerToken(env.ADMIN_PASSWORD);
        const res = await SELF.fetch('https://example.com/refresh', {
            method: 'POST',
            headers: { Authorization: `Bearer ${bearerToken}` },
        });
        expect(res.status).toBe(200);
        const json = (await res.json()) as any;
        expect(json.records).toBeGreaterThan(0);
        expect(json.chunks.total).toBeGreaterThan(0);

        const token = await generateToken(env.ADMIN_PASSWORD);

        // Read sub_1 with token
        const res3 = await SELF.fetch(`https://example.com/sub_1?token=${token}`);
        expect(res3.status).toBe(200); // should exist after refresh
    });
});
