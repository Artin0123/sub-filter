export default {
	async fetch(request, env) {
		return new Response(String(!!env.ASSETS));
	}
}
