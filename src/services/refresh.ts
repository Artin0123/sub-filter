import { KV_KEYS } from '../kv';
import type { AppEnv } from '../lib/env';
import { runUpdate, type RefreshResult } from '../update';

// 刷新鎖的有效時間。KV 是最終一致性，這只是「盡力而為」的去抖動，
// 目的在避免 cron 與手動刷新同時寫入分塊，而不是嚴格的互斥鎖。
const REFRESH_LOCK_TTL_MS = 60_000;

export class RefreshInProgressError extends Error {
	constructor(message = 'refresh_in_progress') {
		super(message);
		this.name = 'RefreshInProgressError';
	}
}

/**
 * 刷新流程先包成 service，避免 route 直接依賴整個更新管線。
 */
export async function refreshSubscriptions(env: AppEnv): Promise<RefreshResult> {
	const startedAt = parseInt((await env.KV_NAMESPACE.get(KV_KEYS.refreshStartedAt)) ?? '0', 10) || 0;
	const now = Date.now();
	if (now - startedAt < REFRESH_LOCK_TTL_MS) throw new RefreshInProgressError();

	await env.KV_NAMESPACE.put(KV_KEYS.refreshStartedAt, String(now));
	try {
		return await runUpdate(env);
	} finally {
		// 只釋放自己持有那把鎖：若本次跑到超過 TTL，鎖可能已被後續的刷新接手，
		// 這時不能再刪，否則第三次刷新會與第二次同時執行。
		const current = await env.KV_NAMESPACE.get(KV_KEYS.refreshStartedAt).catch(() => null);
		if (current === String(now)) {
			await env.KV_NAMESPACE.delete(KV_KEYS.refreshStartedAt).catch(() => {});
		}
	}
}
