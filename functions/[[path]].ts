import { handleRequest } from '../src/index';

export const onRequest: PagesFunction<Env> = (context) => {
	return handleRequest(context.request, context.env);
};
