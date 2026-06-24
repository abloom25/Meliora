import { handleRequest } from '../../server/core/router'
import type { Env } from '../../server/core/types'

export default async function handler(request: Request): Promise<Response> {
  const env: Env = {
    GH_TOKEN: process.env.GH_TOKEN || '',
    GH_REPO: process.env.GH_REPO || '',
    GH_BRANCH: process.env.GH_BRANCH || 'main',
    GITHUB_PROXY: process.env.GITHUB_PROXY || '',
    ADMIN_DISABLED: process.env.ADMIN_DISABLED || '',
    CONFIG_ENCRYPTION_KEY: process.env.CONFIG_ENCRYPTION_KEY || '',
  }
  return handleRequest(request, env)
}
