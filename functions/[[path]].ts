import worker from "../src/index";

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  
  if (url.pathname.includes('.') && url.pathname !== '/') {
    return context.next();
  }

  try {
    const response = await worker.fetch(request, env, context);
    if (response.status === 404) {
      return context.next();
    }
    return response;
  } catch (e) {
    return new Response(JSON.stringify({ 
      error: 'Worker Error', 
      message: e.message 
    }), { 
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }
};
