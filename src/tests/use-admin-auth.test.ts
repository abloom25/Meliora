import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadAuth() {
  vi.resetModules()
  const module = await import('../admin/composables/useAdminAuth')
  return module.useAdminAuth()
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

describe('useAdminAuth setup status', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads disabled setup status from JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'disabled' }))
    vi.stubGlobal('fetch', fetchMock)

    const auth = await loadAuth()
    await auth.checkSetupStatus()

    expect(auth.adminStatus.value).toBe('disabled')
    expect(auth.apiUnavailable.value).toBe(false)
    expect(auth.initialized.value).toBe(true)
    expect(auth.setupChecking.value).toBe(false)
  })

  it('reads env-not-ready setup status detail from JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: 'env-not-ready', detail: 'missing key' }))
    vi.stubGlobal('fetch', fetchMock)

    const auth = await loadAuth()
    await auth.checkSetupStatus()

    expect(auth.adminStatus.value).toBe('env-not-ready')
    expect(auth.adminStatusDetail.value).toBe('missing key')
    expect(auth.apiUnavailable.value).toBe(false)
    expect(auth.initialized.value).toBe(true)
  })

  it('reads normal initialized setup status from JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ initialized: false }))
    vi.stubGlobal('fetch', fetchMock)

    const auth = await loadAuth()
    await auth.checkSetupStatus()

    expect(auth.adminStatus.value).toBe('idle')
    expect(auth.apiUnavailable.value).toBe(false)
    expect(auth.initialized.value).toBe(false)
  })

  it('marks API unavailable for non-JSON setup status responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('not json', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const auth = await loadAuth()
    await auth.checkSetupStatus()

    expect(auth.adminStatus.value).toBe('idle')
    expect(auth.apiUnavailable.value).toBe(true)
    expect(auth.initialized.value).toBe(true)
  })

  it('does not write HTML setup status responses into the document', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<main>unexpected html</main>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    )
    const writeSpy = vi.spyOn(document, 'write').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    const auth = await loadAuth()
    await auth.checkSetupStatus()

    expect(writeSpy).not.toHaveBeenCalled()
    expect(auth.apiUnavailable.value).toBe(true)
    expect(auth.initialized.value).toBe(true)
  })
})
