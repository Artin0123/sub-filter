// Minimal auth helpers: cookie HMAC signing/verification and bearer check.
// NOTE: Proper key management and cookie attributes will be implemented in later steps.

const encoder = new TextEncoder();

export type AuthCookiePayload = {
    sub: string; // fixed subject, e.g., "admin"
    exp: number; // unix seconds expiry
};

function toBase64Url(data: ArrayBuffer | Uint8Array): string {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let str = "";
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(input: string): Uint8Array {
    const pad = input.length % 4 === 2 ? "==" : input.length % 4 === 3 ? "=" : "";
    const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function hmacSha256(key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer> {
    return crypto.subtle.sign({ name: "HMAC" }, key, data);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
    );
}

export async function signCookie(secret: string, payload: AuthCookiePayload): Promise<string> {
    const key = await importHmacKey(secret);
    const body = encoder.encode(JSON.stringify(payload));
    const sig = await hmacSha256(key, body);
    const token = `${toBase64Url(body)}.${toBase64Url(sig)}`;
    return token;
}

export async function verifyCookie(secret: string, token: string): Promise<AuthCookiePayload | null> {
    const [b64Body, b64Sig] = token.split(".");
    if (!b64Body || !b64Sig) return null;
    const key = await importHmacKey(secret);
    const body = fromBase64Url(b64Body);
    const sig = fromBase64Url(b64Sig);
    const ok = await crypto.subtle.verify({ name: "HMAC" }, key, sig, body);
    if (!ok) return null;
    try {
        const payload = JSON.parse(new TextDecoder().decode(body)) as AuthCookiePayload;
        if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch {
        return null;
    }
}

