import { describe, expect, it } from 'vitest'
import { renderDisabledPage, renderEnvNotReadyPage } from '../core/status-pages'
import type { EnvValidation } from '../core/types'

describe('status pages', () => {
  it('renderDisabledPage returns 200 JSON with status disabled', async () => {
    const response = renderDisabledPage()
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('application/json')
    const data = (await response.json()) as { status: string; detail: string }
    expect(data.status).toBe('disabled')
    expect(data.detail).toBe('管理后台已禁用')
  })

  it('renderEnvNotReadyPage returns 200 JSON with status env-not-ready', async () => {
    const envCheck: EnvValidation = {
      ok: false,
      errors: ['CONFIG_ENCRYPTION_KEY 未设置'],
    }
    const response = renderEnvNotReadyPage(envCheck)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('application/json')
    const data = (await response.json()) as { status: string; detail: string }
    expect(data.status).toBe('env-not-ready')
    expect(data.detail).toContain('环境变量未就绪')
  })
})
