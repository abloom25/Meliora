import type { EnvValidation } from './types'

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function renderEnvNotReadyPage(envCheck: EnvValidation): Response {
  const detail = envCheck.errors.length
    ? `环境变量未就绪:${envCheck.errors.join('; ')}`
    : '环境变量未就绪'
  return jsonResponse({ status: 'env-not-ready', detail }, 200)
}

export function renderDisabledPage(): Response {
  return jsonResponse({ status: 'disabled', detail: '管理后台已禁用' }, 200)
}
