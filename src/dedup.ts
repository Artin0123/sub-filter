// Deduplication helpers
import type { NormalizedRecord } from './subscription';

/**
 * 全局去重：同一節點在多個來源、或同一來源內部重複出現時，只保留最先出現的一筆。
 *
 * 判重鍵 = type + 小寫 server + port + 小寫 sni + method + 憑證 + transport variant。
 * variant 是解析階段算好的傳輸層指紋，用來區分「同一組 server/port/uuid/sni 但
 * ws/tcp、不同 reality 公鑰、不同 ss plugin」的節點，避免把它們誤判成重複而丟掉。
 * 節點名稱（備註）不列入比較。
 */
export function dedupRecords(records: NormalizedRecord[]): NormalizedRecord[] {
	const seen = new Set<string>();
	const out: NormalizedRecord[] = [];
	for (const r of records) {
		const server = (r.server || '').trim().toLowerCase();
		const port = r.port | 0;
		if (!server || port <= 0 || port > 65535) continue;
		const type = r.type || '';
		const method = r.method || '';
		const id = r.password || r.uuid || '';
		const sni = (r.servername || r.sni || '').trim().toLowerCase();
		const variant = r.variant || '';
		const key = `${type}:${server}:${port}:${sni}:${method}:${id}:${variant}`;
		if (!seen.has(key)) {
			seen.add(key);
			out.push(r);
		}
	}
	return out;
}
