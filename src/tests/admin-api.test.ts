import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MusicConfig } from '../types/music'

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

  it('marks admin auth as expired when protected mutations receive 401 or 403', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse({ error: '未授权' }, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse({ error: '未授权' }, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    const { useAdminAuth } = await import('../admin/composables/useAdminAuth')
    const { saveConfig, uploadFile } = await import('../admin/services/admin-api')
    const auth = useAdminAuth()

    await expect(auth.login('password')).resolves.toBe(true)
    expect(auth.authenticated.value).toBe(true)
    await expect(saveConfig(validConfig())).resolves.toMatchObject({
      ok: false,
      error: '登录已过期,请重新登录',
    })
    expect(auth.authenticated.value).toBe(false)

    await expect(auth.login('password')).resolves.toBe(true)
    expect(auth.authenticated.value).toBe(true)
    await expect(uploadFile('public/music/a/audio.mp3', 'base64')).resolves.toMatchObject({
      ok: false,
      error: '登录已过期,请重新登录',
    })
    expect(auth.authenticated.value).toBe(false)
  })

  it('can check updates passively without marking admin auth as expired on 403', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true }))
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
    const fetchMock = vi.fn().mockResolvedValueOnce(
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
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
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
