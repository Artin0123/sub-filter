export async function parseBody(req: Request): Promise<Record<string, any>> {
	const ct = req.headers.get('content-type') || '';
	try {
		if (ct.includes('application/json')) return await req.json();
	} catch {}
	if (ct.includes('application/x-www-form-urlencoded')) {
		const form = await req.formData();
		const obj: Record<string, any> = {};
		for (const [k, v] of form.entries()) obj[k] = typeof v === 'string' ? v : String(v);
		return obj;
	}
	const text = await req.text();
	const params = new URLSearchParams(text);
	const obj: Record<string, any> = {};
	for (const [k, v] of params.entries()) obj[k] = v;
	return obj;
}
