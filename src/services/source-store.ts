import { classifySource, isBlockedHttpTarget } from '../fetchers';
import type { AppEnv } from '../lib/env';
import { KV_KEYS } from '../kv';
import { PROTOCOL_TYPES, type ProtocolType } from '../subscription';

/**
 * 訂閱來源清單由 KV 管理。
 * route 層不應直接依賴 key 名稱與序列化細節。
 */
export const MAX_SOURCE_URL_LENGTH = 4096;

export class InputTooLongError extends Error {
	constructor(message = '来源地址过长（上限 4096 字符）') {
		super(message);
		this.name = 'InputTooLongError';
	}
}

export class UnsupportedSourceError extends Error {
	constructor(message = '来源格式不支持，仅接受 http(s)://、inline:') {
		super(message);
		this.name = 'UnsupportedSourceError';
	}
}

export class BlockedSourceError extends Error {
	constructor(message = '来源指向内网或保留地址，已拒绝') {
		super(message);
		this.name = 'BlockedSourceError';
	}
}

export async function listSources(env: AppEnv): Promise<string[]> {
	const sources = await env.KV_NAMESPACE.get(KV_KEYS.sources, { type: 'json' });
	return Array.isArray(sources) ? (sources as string[]) : [];
}

/**
 * 新增來源。
 * 只做「格式」層的校驗（長度、scheme、是否指向私網）；實際抓取成功與否由刷新流程回報，
 * 這樣使用者可以先貼上暫時連不上的來源，之後再刷新。
 */
export async function addSource(env: AppEnv, url: string): Promise<void> {
	if (url.length > MAX_SOURCE_URL_LENGTH) throw new InputTooLongError();
	const kind = classifySource(url);
	if (!kind) throw new UnsupportedSourceError();
	if (kind === 'http' && isBlockedHttpTarget(url)) throw new BlockedSourceError();
	const sources = await listSources(env);
	if (!sources.includes(url)) {
		sources.push(url);
		await env.KV_NAMESPACE.put(KV_KEYS.sources, JSON.stringify(sources));
	}
}

export async function removeSource(env: AppEnv, url: string): Promise<void> {
	const sources = await listSources(env);
	const next = sources.filter((source) => source !== url);
	await env.KV_NAMESPACE.put(KV_KEYS.sources, JSON.stringify(next));
	const filters = await getSourceFilters(env);
	if (url in filters) {
		delete filters[url];
		await env.KV_NAMESPACE.put(KV_KEYS.sourceFilters, JSON.stringify(filters));
	}
}

export type SourceFilters = Record<string, ProtocolType[]>;

// 只保留合法的協議名稱並去重；格式不對的紀錄視為「不過濾」，避免壞資料把來源濾成空。
function sanitizeTypes(value: unknown): ProtocolType[] {
	if (!Array.isArray(value)) return [];
	return PROTOCOL_TYPES.filter((t) => value.includes(t));
}

export async function getSourceFilters(env: AppEnv): Promise<SourceFilters> {
	const raw = await env.KV_NAMESPACE.get(KV_KEYS.sourceFilters, { type: 'json' });
	const result: SourceFilters = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
	for (const [url, value] of Object.entries(raw)) {
		const types = sanitizeTypes(value);
		if (types.length > 0) result[url] = types;
	}
	return result;
}

/** 設定單一來源的協議過濾；空陣列等於清除（不過濾）。 */
export async function setSourceFilter(env: AppEnv, url: string, types: string[]): Promise<void> {
	const valid = sanitizeTypes(types);
	const filters = await getSourceFilters(env);
	if (valid.length === 0) delete filters[url];
	else filters[url] = valid;
	await env.KV_NAMESPACE.put(KV_KEYS.sourceFilters, JSON.stringify(filters));
}
