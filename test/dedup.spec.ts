import { describe, it, expect } from 'vitest';
import { dedupRecords } from '../src/dedup';
import type { NormalizedRecord } from '../src/subscription';

describe('dedup', () => {
    it('keeps one by key and drops empty server', () => {
        const a: NormalizedRecord = { type: 'vless', server: 'h', port: 443, uuid: 'u' } as any;
        const b: NormalizedRecord = { type: 'vless', server: 'H', port: 443, uuid: 'u' } as any; // same key (case-insensitive)
        const c: NormalizedRecord = { type: 'trojan', server: '', port: 443, password: 'p' } as any; // drop
        const d: NormalizedRecord = { type: 'trojan', server: 'h', port: 443, password: 'p' } as any;
        const out = dedupRecords([a, b, c, d]);
        expect(out.length).toBe(2);
    });
});
