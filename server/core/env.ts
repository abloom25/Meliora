import { resolveDeploymentEnv } from '../../shared/env-schema'
import type { Env } from './types'

// 三个平台入口(Vercel / Cloudflare Pages / Netlify)共用同一份 Env 构造逻辑,
// 仅 env 来源(process.env 或平台注入的 env 对象)与 clientIp 请求头不同。
export function buildEdgeEnv(envLike: Record<string, string | undefined>): Env {
  const deploymentEnv = resolveDeploymentEnv(envLike)
  return {
    GH_TOKEN: deploymentEnv.GH_TOKEN || '',
    GH_REPO: deploymentEnv.GH_REPO,
    GH_BRANCH: deploymentEnv.GH_BRANCH,
    GITHUB_PROXY: envLike.GITHUB_PROXY || '',
    ADMIN_DISABLED: envLike.ADMIN_DISABLED || '',
    DEVELOPMENT: envLike.DEVELOPMENT || '',
    CONFIG_ENCRYPTION_KEY: envLike.CONFIG_ENCRYPTION_KEY || '',
  }
}
