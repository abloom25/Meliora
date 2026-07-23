import { buildEdgeEnv } from '../../server/core/env'
import { handleRequest } from '../../server/core/router'

export default async function handler(request: Request): Promise<Response> {
  return handleRequest(request, buildEdgeEnv(process.env), {
    clientIp: request.headers.get('x-nf-client-connection-ip') || undefined,
  })
}
