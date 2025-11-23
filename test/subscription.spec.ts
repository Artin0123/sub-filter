import { describe, it, expect } from 'vitest';
import { parseUriToRecord, encodeRecordToUri, safeBase64Decode } from '../src/subscription';

describe('subscription parsing', () => {
    it('parses vmess/vless/trojan/ss/hysteria2 happy paths', () => {
        const vm = parseUriToRecord('vmess://' + btoa(JSON.stringify({ add: 'a.test', port: 443, id: 'u', sni: 'a.test', tls: 'tls', ps: 'n' })));
        expect(vm?.type).toBe('vmess');

        const vl = parseUriToRecord('vless://u@b.test:443?sni=b.test#n');
        expect(vl?.type).toBe('vless');

        const tr = parseUriToRecord('trojan://p@c.test:443?sni=c.test#n');
        expect(tr?.type).toBe('trojan');

        const ss = parseUriToRecord('ss://method:pass@d.test:443#n');
        expect(ss?.type).toBe('ss');

        const hy2 = parseUriToRecord('hysteria2://mypass@f.test:8443?sni=f.test&obfs=salamander#hy2-node');
        expect(hy2?.type).toBe('hysteria2');
        expect(hy2?.password).toBe('mypass');
        expect(hy2?.obfs).toBe('salamander');
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
        expect(parseUriToRecord('hysteria2://nohost')).toBeNull();
    });

    it('round-trips hysteria2 encoding', () => {
        const rec = parseUriToRecord('hysteria2://secret@server.test:8443?sni=server.test&obfs=salamander&insecure=1#my-hy2');
        expect(rec).not.toBeNull();
        const encoded = encodeRecordToUri(rec!);
        expect(encoded).toContain('hysteria2://');
        expect(encoded).toContain('server.test:8443');
        expect(encoded).toContain('obfs=salamander');
    });
});
