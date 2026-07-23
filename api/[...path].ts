import { buildEdgeEnv } from '../server/core/env'
import { handleRequest } from '../server/core/router'

export const config = { runtime: 'edge' }

export default async function handler(request: Request): Promise<Response> {
  return handleRequest(request, buildEdgeEnv(process.env), {
    clientIp: request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim(),
  })
}
