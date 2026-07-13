import { handleRequest } from '../../server/core/router'
import type { Env } from '../../server/core/types'
import { resolveDeploymentEnv } from '../../shared/env-schema'

interface PagesFunctionContext {
  request: Request
  env: Record<string, string | undefined>
}

export const onRequest = async (context: PagesFunctionContext): Promise<Response> => {
  const deploymentEnv = resolveDeploymentEnv(context.env)
  const env: Env = {
    GH_TOKEN: deploymentEnv.GH_TOKEN || '',
    GH_REPO: deploymentEnv.GH_REPO,
    GH_BRANCH: deploymentEnv.GH_BRANCH,
    GITHUB_PROXY: context.env.GITHUB_PROXY || '',
    ADMIN_DISABLED: context.env.ADMIN_DISABLED || '',
    DEVELOPMENT: context.env.DEVELOPMENT || '',
    CONFIG_ENCRYPTION_KEY: context.env.CONFIG_ENCRYPTION_KEY || '',
  }
  return handleRequest(context.request, env, {
    clientIp: context.request.headers.get('CF-Connecting-IP') || undefined,
  })
}
