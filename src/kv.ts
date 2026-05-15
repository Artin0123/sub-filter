// 專案使用的 KV key 全部集中在這裡，避免字串散落各處。
export const KV_KEYS = {
	sources: 'sources',
	chunkSize: 'chunk_size',
	base64Encode: 'base64_encode',
	chunksTotal: 'chunks_total',
	subTxtI: (i: number) => `sub_txt_${i}`,
	etagI: (i: number) => `etag_${i}`,
	lastUpdatedISO: 'last_updated_iso',
	lastStats: 'last_stats',
} as const;

// 目前不保留額外 helper，讓 key surface 維持最小。
