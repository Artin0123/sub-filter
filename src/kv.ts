// KV helpers and keys used in the project

export const KV_KEYS = {
    sources: "sources",
    chunkSize: "chunk_size",
    base64Encode: "base64_encode",
    chunksTotal: "chunks_total",
    subTxtI: (i: number) => `sub_txt_${i}`,
    etagI: (i: number) => `etag_${i}`,
    lastUpdatedISO: "last_updated_iso",
    lastStats: "last_stats",
} as const;

// Removed unused KV helper functions to keep the surface minimal.
