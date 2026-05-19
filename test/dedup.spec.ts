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
});
