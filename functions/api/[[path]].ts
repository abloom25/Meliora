import { handleRequest } from '../../server/core/router'
import type { Env } from '../../server/core/types'

interface PagesFunctionContext {
  request: Request
  env: Record<string, string | undefined>
}

export const onRequest = async (context: PagesFunctionContext): Promise<Response> => {
  const env: Env = {
    GH_TOKEN: context.env.GH_TOKEN || '',
    GH_REPO: context.env.GH_REPO || '',
    GH_BRANCH: context.env.GH_BRANCH || 'main',
    GITHUB_PROXY: context.env.GITHUB_PROXY || '',
    ADMIN_DISABLED: context.env.ADMIN_DISABLED || '',
    DEVELOPMENT: context.env.DEVELOPMENT || '',
    CONFIG_ENCRYPTION_KEY: context.env.CONFIG_ENCRYPTION_KEY || '',
  }
  return handleRequest(context.request, env)
}
