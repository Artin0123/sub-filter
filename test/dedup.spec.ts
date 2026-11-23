import { describe, it, expect } from 'vitest';
import { dedupRecords } from '../src/dedup';
import { parseUriToRecord, type NormalizedRecord } from '../src/subscription';

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

	it('keeps nodes that only differ in transport parameters', () => {
		// 同一組 server/port/uuid/sni，但 tcp 與 ws、不同 reality 公鑰，都是不同節點。
		const tcp = parseUriToRecord('vless://u@h.test:443?sni=h.test&type=tcp#a')!;
		const ws = parseUriToRecord('vless://u@h.test:443?sni=h.test&type=ws&path=%2Fws#b')!;
		const reality1 = parseUriToRecord('vless://u@h.test:443?security=reality&sni=h.test&pbk=KEY1#c')!;
		const reality2 = parseUriToRecord('vless://u@h.test:443?security=reality&sni=h.test&pbk=KEY2#d')!;

		const out = dedupRecords([tcp, ws, reality1, reality2]);
		// tcp 與 ws 都有 …&type=…（值不同）→ 各自保留；兩把 reality 金鑰也各自保留；
		// 但 tcp 那筆沒有 security 參數、reality 有，因此四筆互不相同。
		expect(out).toHaveLength(4);
	});

	it('still merges nodes that differ only by name or query order', () => {
		const a = parseUriToRecord('vless://u@h.test:443?security=tls&sni=h.test&type=tcp#name-a')!;
		const b = parseUriToRecord('vless://u@h.test:443?type=tcp&sni=h.test&security=tls#name-b')!;
		const out = dedupRecords([a, b]);
		expect(out).toHaveLength(1);
		expect(out[0].rawUri).toBe(a.rawUri);
	});

	it('treats ss plugin settings as part of the node identity', () => {
		const plain = parseUriToRecord('ss://YWVzLTI1Ni1nY206cGFzcw@h.test:8388#a')!;
		const withPlugin = parseUriToRecord('ss://YWVzLTI1Ni1nY206cGFzcw@h.test:8388?plugin=v2ray-plugin%3Btls#b')!;
		expect(dedupRecords([plain, withPlugin])).toHaveLength(2);
	});

	it('accepts port 65535 and rejects port 65536', () => {
		const max: NormalizedRecord = { type: 'vless', rawUri: 'vless://u@h:65535', server: 'h', port: 65535, uuid: 'u' } as any;
		const tooBig: NormalizedRecord = { type: 'vless', rawUri: 'vless://u@h:65536', server: 'h', port: 65536, uuid: 'u' } as any;
		const out = dedupRecords([max, tooBig]);
		expect(out.map((r) => r.port)).toEqual([65535]);
	});
});
