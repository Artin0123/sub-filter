/**
 * 有上限的併發 map。
 *
 * 和「切批次 + Promise.all」相比，這個版本不會被最慢的一筆拖住整批，
 * 但仍確保同時執行的任務數不超過 limit；回傳順序與輸入一致。
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	if (items.length === 0) return results;

	const workerCount = Math.max(1, Math.min(limit, items.length));
	let cursor = 0;

	const worker = async () => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	};

	await Promise.all(Array.from({ length: workerCount }, worker));
	return results;
}
