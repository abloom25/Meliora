import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MusicConfig } from '../../shared/music-config'

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

function validConfig(patch: Partial<MusicConfig> = {}): MusicConfig {
  return {
    siteName: 'Meliora',
    apiEndpoint: '',
    playlists: [],
    localTracks: [],
    ...patch,
  }
}

describe('admin-api', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('marks admin auth as expired when config loading receives 401', async () => {
    const fetchMock = vi
      .fn()
      // 登录前内存无 token,fetchWithCsrf 先通过 /api/auth 尝试获取
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse({ error: '未授权' }, { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const { useAdminAuth } = await import('../admin/composables/useAdminAuth')
    const { fetchConfig } = await import('../admin/services/admin-api')
    const auth = useAdminAuth()

    await expect(auth.login('password')).resolves.toBe(true)
    expect(auth.authenticated.value).toBe(true)

    await expect(fetchConfig()).resolves.toBeNull()

    expect(auth.authenticated.value).toBe(false)
    expect(auth.checking.value).toBe(false)
  })

  it('marks admin auth as expired when protected mutations receive 401', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(
        jsonResponse({ success: true }, { headers: { 'X-CSRF-Token': 'login-token' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: '未授权' }, { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const { useAdminAuth } = await import('../admin/composables/useAdminAuth')
    const { saveConfig } = await import('../admin/services/admin-api')
    const auth = useAdminAuth()

    await expect(auth.login('password')).resolves.toBe(true)
    expect(auth.authenticated.value).toBe(true)
    await expect(saveConfig(validConfig())).resolves.toMatchObject({
      ok: false,
      error: '登录已过期,请重新登录',
    })
    expect(auth.authenticated.value).toBe(false)
  })

  it('refreshes the in-memory CSRF token and retries once on 403', async () => {
    const fetchMock = vi
      .fn()
      // 登录前 ensureCsrfToken 的 /api/auth
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      // 登录,响应头下发初始 CSRF token
      .mockResolvedValueOnce(
        jsonResponse({ success: true }, { headers: { 'X-CSRF-Token': 'stale-token' } }),
      )
      // 第一次保存:旧 token 已被服务端吊销
      .mockResolvedValueOnce(jsonResponse({ error: 'CSRF 令牌无效或已过期' }, { status: 403 }))
      // 重试前重新获取,下发新 token
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true }, { headers: { 'X-CSRF-Token': 'fresh-token' } }),
      )
      // 重试成功
      .mockResolvedValueOnce(jsonResponse({ sha: 'commit-next' }))
    vi.stubGlobal('fetch', fetchMock)

    const { useAdminAuth } = await import('../admin/composables/useAdminAuth')
    const { saveConfig } = await import('../admin/services/admin-api')
    const auth = useAdminAuth()

    await expect(auth.login('password')).resolves.toBe(true)
    const result = await saveConfig(validConfig())

    expect(result.ok).toBe(true)
    // 403 不再视为登录过期
    expect(auth.authenticated.value).toBe(true)

    const reAuthCall = fetchMock.mock.calls[3]
    expect(reAuthCall[0]).toBe('/api/auth')
    const retryCall = fetchMock.mock.calls[4]
    expect(retryCall[0]).toBe('/api/config')
    expect(retryCall[1]?.headers).toMatchObject({ 'X-CSRF-Token': 'fresh-token' })
    // token 只存内存,不落 localStorage
    expect(localStorage.getItem('meliora_csrf')).toBeNull()
  })

  it('surfaces the backend error when the retry after 403 still fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(
        jsonResponse({ success: true }, { headers: { 'X-CSRF-Token': 'stale-token' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: 'CSRF 令牌无效或已过期' }, { status: 403 }))
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true }, { headers: { 'X-CSRF-Token': 'fresh-token' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: 'CSRF 令牌无效或已过期' }, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    const { useAdminAuth } = await import('../admin/composables/useAdminAuth')
    const { saveConfig } = await import('../admin/services/admin-api')
    const auth = useAdminAuth()

    await expect(auth.login('password')).resolves.toBe(true)
    const result = await saveConfig(validConfig())

    expect(result).toMatchObject({ ok: false, error: 'CSRF 令牌无效或已过期' })
    expect(auth.authenticated.value).toBe(true)
  })

  it('ignores any CSRF token planted in localStorage by older versions', async () => {
    localStorage.setItem('meliora_csrf', 'planted-token')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ authenticated: true }))
      .mockResolvedValueOnce(
        jsonResponse({ path: 'public/music/a/audio.mp3', blobSha: 'a'.repeat(40) }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const { uploadFile } = await import('../admin/services/admin-api')
    const result = await uploadFile('public/music/a/audio.mp3', 'base64')

    expect(result.ok).toBe(true)
    const uploadCall = fetchMock.mock.calls.find((call) => call[0] === '/api/upload')
    expect(uploadCall?.[1]?.headers).not.toHaveProperty('X-CSRF-Token')
  })

  it('can check updates passively without marking admin auth as expired on 403', async () => {
    const fetchMock = vi
      .fn()
      // 登录前 ensureCsrfToken 的 /api/auth
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      // check-update 前 ensureCsrfToken 的 /api/auth
      .mockResolvedValueOnce(jsonResponse({ authenticated: true }))
      .mockResolvedValueOnce(jsonResponse({ error: '未授权' }, { status: 403 }))
      // 403 后清除 token 重试:再次 /api/auth + 重试仍 403
      .mockResolvedValueOnce(jsonResponse({ authenticated: true }))
      .mockResolvedValueOnce(jsonResponse({ error: '未授权' }, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    const { useAdminAuth } = await import('../admin/composables/useAdminAuth')
    const { checkUpdate } = await import('../admin/services/admin-api')
    const auth = useAdminAuth()

    await expect(auth.login('password')).resolves.toBe(true)
    expect(auth.authenticated.value).toBe(true)

    const result = await checkUpdate('0.2.0', '', false, undefined, {
      markUnauthenticated: false,
    })

    expect(result).toEqual({ ok: false, error: '未授权' })
    expect(auth.authenticated.value).toBe(true)
  })

  it('accepts base64 content length produced by an exact 25 MiB file', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ path: 'public/music/a/audio.mp3', blobSha: 'a'.repeat(40) }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const { MAX_UPLOAD_BASE64_LENGTH, uploadFile } = await import('../admin/services/admin-api')
    const result = await uploadFile(
      'public/music/a/audio.mp3',
      'a'.repeat(MAX_UPLOAD_BASE64_LENGTH),
    )

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('sends config and staged blob references in one save request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sha: 'commit-next' }))
    vi.stubGlobal('fetch', fetchMock)

    const { saveConfig } = await import('../admin/services/admin-api')
    const current = validConfig({
      siteIcon: './icon.png',
    })
    const uploads = [{ path: 'public/icon.png', blobSha: 'a'.repeat(40) }]
    const result = await saveConfig(current, uploads)

    expect(result.ok).toBe(true)
    const configCall = fetchMock.mock.calls.find((call) => call[0] === '/api/config')
    expect(configCall).toBeDefined()
    expect(JSON.parse(String(configCall?.[1]?.body))).toEqual({ config: current, uploads })
  })

  it('does not send invalid empty local tracks to the backend', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { saveConfig } = await import('../admin/services/admin-api')
    const result = await saveConfig(
      validConfig({
        localTracks: [{ id: 'track-1', title: '', artist: '', audio: '' }],
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.error).toContain('localTracks[0].title 必须是非空字符串')
    expect(result.error).toContain('localTracks[0].artist 必须是非空字符串')
    expect(result.error).toContain('localTracks[0].audio 必须是非空字符串')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('checks updates with POST JSON and forwards backend detail errors', async () => {
    const fetchMock = vi
      .fn()
      // 首次写请求前 ensureCsrfToken 的 /api/auth
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: '触发失败: 403', detail: 'Resource not accessible' },
          { status: 502 },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const { checkUpdate } = await import('../admin/services/admin-api')
    const result = await checkUpdate('0.2.0', 'https://proxy.example/?url={url}', true)

    expect(result).toEqual({ ok: false, error: 'Resource not accessible' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/check-update',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current: '0.2.0',
          githubProxy: 'https://proxy.example/?url={url}',
          receivePrereleaseUpdates: true,
        }),
      }),
    )
  })

  it('returns triggeredAt from update trigger responses', async () => {
    const fetchMock = vi
      .fn()
      // 首次写请求前 ensureCsrfToken 的 /api/auth
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(
        jsonResponse({
          message: '已触发',
          triggeredAt: '2026-06-30T10:00:00.000Z',
          triggerId: 'dispatch-123',
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const { triggerUpdate } = await import('../admin/services/admin-api')
    const result = await triggerUpdate('https://proxy.example/?url={url}', 'v0.3.0', true)

    expect(result).toEqual({
      ok: true,
      message: '已触发',
      triggeredAt: '2026-06-30T10:00:00.000Z',
      triggerId: 'dispatch-123',
    })
    const updateCall = fetchMock.mock.calls.find((call) => call[0] === '/api/update')
    expect(JSON.parse(String(updateCall?.[1]?.body))).toEqual({
      githubProxy: 'https://proxy.example/?url={url}',
      targetTag: 'v0.3.0',
      receivePrereleaseUpdates: true,
    })
  })

  it('fetches update status with credentials and preserves failure messages', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        run: {
          id: 123,
          runNumber: 7,
          runAttempt: 1,
          event: 'workflow_dispatch',
          branch: 'main',
          status: 'completed',
          conclusion: 'failure',
          displayStatus: 'failed',
          createdAt: '2026-06-30T10:00:00.000Z',
          updatedAt: '2026-06-30T10:05:00.000Z',
          htmlUrl: 'https://github.com/owner/repo/actions/runs/123',
        },
        failure: { message: '验证失败' },
        message: '更新失败',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { fetchUpdateStatus } = await import('../admin/services/admin-api')
    const result = await fetchUpdateStatus('2026-06-30T10:00:00.000Z', 'dispatch-123')

    expect(result.ok).toBe(true)
    expect(result.data?.failure?.message).toBe('验证失败')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/update/status?since=2026-06-30T10%3A00%3A00.000Z&triggerId=dispatch-123',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('prefers backend detail when update status lookup fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'GitHub 鉴权失败',
          message: 'GitHub 鉴权失败',
          detail: 'GitHub workflow runs failed: 403: Resource not accessible',
        },
        { status: 502 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { fetchUpdateStatus } = await import('../admin/services/admin-api')
    const result = await fetchUpdateStatus('2026-06-30T10:00:00.000Z', 'dispatch-123')

    expect(result).toEqual({
      ok: false,
      error: 'GitHub workflow runs failed: 403: Resource not accessible',
    })
  })
})
