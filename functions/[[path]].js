export const onRequest = async (context) => {
  return new Response("Not found", { status: 404 });
};