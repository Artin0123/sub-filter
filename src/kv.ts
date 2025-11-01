// KV helpers and keys used in the project

export const KV_KEYS = {
    sources: "sources",
    chunkSize: "chunk_size",
    chunksTotal: "chunks_total",
    subTxt: "sub_txt",
    etag: "etag",
    subTxtI: (i: number) => `sub_txt_${i}`,
    etagI: (i: number) => `etag_${i}`,
    lastUpdatedISO: "last_updated_iso",
} as const;

export type KVLike = KVNamespace;

export async function getJSON<T>(kv: KVLike, key: string, fallback: T): Promise<T> {
    const val = await kv.get(key, { type: "json" });
    return (val as T | null) ?? fallback;
}

export async function getText(kv: KVLike, key: string): Promise<string | null> {
    return kv.get(key);
}

export async function putTextIfChanged(kv: KVLike, key: string, value: string, currentEtag: string | null, newEtag: string): Promise<boolean> {
    if (currentEtag === newEtag) return false;
    await kv.put(key, value);
    return true;
}
