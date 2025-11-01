import { describe, it, expect } from 'vitest';
import { signCookie, verifyCookie, isBearerValid } from '../src/auth';

describe('auth', () => {
    it('sign and verify cookie with expiry', async () => {
        const secret = 's3cret';
        const token = await signCookie(secret, { sub: 'admin', exp: Math.floor(Date.now() / 1000) + 60 });
        const ok = await verifyCookie(secret, token);
        expect(ok?.sub).toBe('admin');
    });
    it('expired cookie invalid', async () => {
        const secret = 's3cret';
        const token = await signCookie(secret, { sub: 'admin', exp: Math.floor(Date.now() / 1000) - 1 });
        const ok = await verifyCookie(secret, token);
        expect(ok).toBeNull();
    });
    it('bearer validation', () => {
        expect(isBearerValid('Bearer abc', 'abc')).toBe(true);
        expect(isBearerValid('Bearer wrong', 'abc')).toBe(false);
        expect(isBearerValid(null, 'abc')).toBe(false);
    });
});
