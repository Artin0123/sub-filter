import type { AppEnv } from '../lib/env';
import { runUpdate, type RefreshResult } from '../update';

/**
 * 刷新流程先包成 service，避免 route 直接依賴整個更新管線。
 */
export async function refreshSubscriptions(env: AppEnv): Promise<RefreshResult> {
	return runUpdate(env);
}
