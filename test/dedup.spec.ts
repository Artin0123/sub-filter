import { describe, it, expect } from 'vitest';
import { dedupRecords } from '../src/dedup';
import type { NormalizedRecord } from '../src/subscription';

describe('dedup', () => {
    it('keeps one by key and drops empty server', () => {
        const a: NormalizedRecord = { type: 'vless', rawUri: 'vless://u@h:443#1', server: 'h', port: 443, uuid: 'u' } as any;
        const b: NormalizedRecord = { type: 'vless', rawUri: 'vless://u@H:443#2', server: 'H', port: 443, uuid: 'u' } as any; // same key (case-insensitive)
        const c: NormalizedRecord = { type: 'trojan', rawUri: 'trojan://p@:443#3', server: '', port: 443, password: 'p' } as any; // drop
        const d: NormalizedRecord = { type: 'trojan', rawUri: 'trojan://p@h:443#4', server: 'h', port: 443, password: 'p' } as any;
        const out = dedupRecords([a, b, c, d]);
        expect(out.length).toBe(2);
    });

    it('keeps records with different protocol types or ss methods and normalizes sni case', () => {
        const vless: NormalizedRecord = { type: 'vless', rawUri: 'vless://secret@h:443?sni=Example.COM#1', server: 'h', port: 443, sni: 'Example.COM', uuid: 'secret' } as any;
        const vlessDup: NormalizedRecord = { type: 'vless', rawUri: 'vless://secret@h:443?sni=example.com#2', server: 'h', port: 443, sni: 'example.com', uuid: 'secret' } as any;
        const trojan: NormalizedRecord = { type: 'trojan', rawUri: 'trojan://secret@h:443?sni=example.com#3', server: 'h', port: 443, sni: 'example.com', password: 'secret' } as any;
        const ss1: NormalizedRecord = { type: 'ss', rawUri: 'ss://aes-256-gcm:secret@h:443#4', server: 'h', port: 443, method: 'aes-256-gcm', password: 'secret' } as any;
        const ss2: NormalizedRecord = { type: 'ss', rawUri: 'ss://chacha20-ietf-poly1305:secret@h:443#5', server: 'h', port: 443, method: 'chacha20-ietf-poly1305', password: 'secret' } as any;
        const invalidPort: NormalizedRecord = { type: 'vless', rawUri: 'vless://secret@h:70000#6', server: 'h', port: 70000, uuid: 'secret' } as any;

        const out = dedupRecords([vless, vlessDup, trojan, ss1, ss2, invalidPort]);
        expect(out).toHaveLength(4);
        expect(out.map((r) => r.rawUri)).toEqual([vless.rawUri, trojan.rawUri, ss1.rawUri, ss2.rawUri]);
    });
});
