import { describe, it, expect } from 'vitest';
import { parseUriToRecord, encodeRecordToUri, safeBase64Decode } from '../src/subscription';

describe('subscription parsing', () => {
    it('parses vmess/vless/trojan/ss happy paths', () => {
        const vm = parseUriToRecord('vmess://' + btoa(JSON.stringify({ add: 'a.test', port: 443, id: 'u', sni: 'a.test', tls: 'tls', ps: 'n' })));
        expect(vm?.type).toBe('vmess');

        const vl = parseUriToRecord('vless://u@b.test:443?sni=b.test#n');
        expect(vl?.type).toBe('vless');

        const tr = parseUriToRecord('trojan://p@c.test:443?sni=c.test#n');
        expect(tr?.type).toBe('trojan');

        const ss = parseUriToRecord('ss://method:pass@d.test:443#n');
        expect(ss?.type).toBe('ss');
    });

    it('parses ss with plugin query parameters', () => {
        const rec = parseUriToRecord('ss://bWV0aG9kOnBhc3M=@e.test:8388?plugin=v2ray-plugin;tls#with-plugin');
        expect(rec?.type).toBe('ss');
        expect(rec?.server).toBe('e.test');
        expect(rec?.port).toBe(8388);
    });

    it('rejects malformed URIs', () => {
        expect(parseUriToRecord('vmess://not-json')).toBeNull();
        expect(parseUriToRecord('vless://missing')).toBeNull();
        expect(parseUriToRecord('ss://')).toBeNull();
    });
});
