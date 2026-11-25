// 專案使用的 KV key 全部集中在這裡，避免字串散落各處。
export const KV_KEYS = {
	sources: 'sources',
	// 每個來源的協議過濾：{ [url]: ProtocolType[] }，沒有紀錄代表不過濾。
	sourceFilters: 'source_filters',
	chunkSize: 'chunk_size',
	base64Encode: 'base64_encode',
	chunksTotal: 'chunks_total',
	subTxtI: (i: number) => `sub_txt_${i}`,
	etagI: (i: number) => `etag_${i}`,
	lastUpdatedISO: 'last_updated_iso',
	lastStats: 'last_stats',
	// 上次刷新使用的 base64 設定；切換時必須強制重寫所有分塊。
	lastBase64Setting: 'last_base64_setting',
	// 訂閱端點使用的獨立 token，與 ADMIN_PASSWORD 解耦。
	subscriptionToken: 'subscription_token',
	// 刷新鎖（盡力而為，KV 為最終一致性），避免 cron 與手動刷新同時寫入。
	refreshStartedAt: 'refresh_started_at',
} as const;

/**
 * 值沒變就不寫。KV 免費額度每天只有 1000 次寫入，讀取則寬鬆得多（10 萬次），
 * 所以「先讀再比對」比無條件覆寫划算。回傳是否真的寫入。
 */
export async function putIfChanged(kv: KVNamespace, key: string, value: string): Promise<boolean> {
	if ((await kv.get(key)) === value) return false;
	await kv.put(key, value);
	return true;
}