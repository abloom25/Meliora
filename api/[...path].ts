import { handleRequest } from '../server/core/router'
import type { Env } from '../server/core/types'
import { resolveDeploymentEnv } from '../shared/env-schema'

export const config = { runtime: 'edge' }

export default async function handler(request: Request): Promise<Response> {
  const deploymentEnv = resolveDeploymentEnv(process.env)
  const env: Env = {
    GH_TOKEN: deploymentEnv.GH_TOKEN || '',
    GH_REPO: deploymentEnv.GH_REPO,
    GH_BRANCH: deploymentEnv.GH_BRANCH,
    GITHUB_PROXY: process.env.GITHUB_PROXY || '',
    ADMIN_DISABLED: process.env.ADMIN_DISABLED || '',
    DEVELOPMENT: process.env.DEVELOPMENT || '',
    CONFIG_ENCRYPTION_KEY: process.env.CONFIG_ENCRYPTION_KEY || '',
  }
  return handleRequest(request, env, {
    clientIp: request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim(),
  })
}
