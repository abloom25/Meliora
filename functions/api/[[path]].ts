import { buildEdgeEnv } from '../../server/core/env'
import { handleRequest } from '../../server/core/router'

interface PagesFunctionContext {
  request: Request
  env: Record<string, string | undefined>
}

export const onRequest = async (context: PagesFunctionContext): Promise<Response> => {
  return handleRequest(context.request, buildEdgeEnv(context.env), {
    clientIp: context.request.headers.get('CF-Connecting-IP') || undefined,
  })
}
