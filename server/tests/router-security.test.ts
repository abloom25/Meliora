import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCookieHeader, signToken } from '../core/auth'
import { setupPassword } from '../core/admin-auth-store'
import { handleRequest } from '../core/router'
import type { Env } from '../core/types'
import { generateCsrfToken } from '../core/csrf'
import { getSigningSecret } from '../core/auth'

const ENV: Env = {
  GH_TOKEN: 'placeholder',
  GH_REPO: 'owner/repo',
  GH_BRANCH: 'main',
  CONFIG_ENCRYPTION_KEY: '',
  DEVELOPMENT: 'true',
}

describe('router security gates', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function authCookie(): Promise<string> {
    return createCookieHeader(await signToken(ENV)).split(';')[0]
  }

  async function expectRuntimeConfigNotFound(env: Env): Promise<void> {
    const response = await handleRequest(new Request('https://example.com/api/runtime-config'), env)
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(404)
    expect(data.error).toBe('未找到')
  }

  it('injects baseline security headers into every API response', async () => {
    const notFound = await handleRequest(new Request('https://example.com/api/nope'), ENV)
    expect(notFound.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(notFound.headers.get('Cache-Control')).toBe('no-store')

    const forbidden = await handleRequest(
      new Request('https://example.com/api/config', { method: 'PUT' }),
      { ...ENV, ADMIN_DISABLED: 'true' },
    )
    expect(forbidden.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(forbidden.headers.get('Cache-Control')).toBe('no-store')
  })

  it('rejects oversized login bodies before parsing (Content-Length precheck)', async () => {
    const response = await handleRequest(
      new Request('https://example.com/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'x'.repeat(100 * 1024) }),
      }),
      ENV,
    )

    expect(response.status).toBe(413)
  })

  it('rejects oversized streaming bodies without Content-Length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"password":"${'x'.repeat(100 * 1024)}`))
        controller.enqueue(new TextEncoder().encode('"}'))
        controller.close()
      },
    })
    const response = await handleRequest(
      new Request('https://example.com/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stream,
        // undici 流式请求体需要声明 duplex
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      ENV,
    )

    expect(response.status).toBe(413)
  })

  it('requires authentication before checking updates', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await handleRequest(
      new Request('https://example.com/api/check-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
        body: JSON.stringify({ current: '0.1.0', githubProxy: 'https://proxy.test' }),
      }),
      ENV,
    )
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(401)
    expect(data.error).toBe('未授权')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rate limits repeated failed login attempts', async () => {
    let response = new Response(null)

    for (let i = 0; i < 9; i += 1) {
      response = await handleRequest(
        new Request('https://example.com/api/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '203.0.113.42',
            'User-Agent': 'rate-limit-test',
          },
          body: JSON.stringify({ password: 'wrong-password' }),
        }),
        ENV,
        { clientIp: '203.0.113.42' },
      )
    }

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBeTruthy()
  })

  it('rejects cross-origin write requests before authenticated admin handlers run', async () => {
    const response = await handleRequest(
      new Request('https://example.com/api/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://attacker.example',
          Cookie: await authCookie(),
        },
        body: JSON.stringify({}),
      }),
      ENV,
    )
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(403)
    expect(data.error).toBe('跨站请求已拒绝')
  })

  it('rejects cross-site referer write requests when Origin is absent', async () => {
    const response = await handleRequest(
      new Request('https://example.com/api/file', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://attacker.example/admin',
          Cookie: await authCookie(),
        },
        body: JSON.stringify({ paths: ['public/music/track.mp3'] }),
      }),
      ENV,
    )

    expect(response.status).toBe(403)
  })

  it('allows same-origin write requests through to the normal auth gate', async () => {
    const response = await handleRequest(
      new Request('https://example.com/api/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://example.com',
        },
        body: JSON.stringify({}),
      }),
      ENV,
    )
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(401)
    expect(data.error).toBe('未授权')
  })

  it('accepts an authenticated same-origin write with a valid CSRF token', async () => {
    const csrfToken = await generateCsrfToken(await getSigningSecret(ENV))
    const response = await handleRequest(
      new Request('https://example.com/api/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://example.com',
          Cookie: await authCookie(),
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          siteName: 'Meliora',
          apiEndpoint: '',
          playlists: [],
          localTracks: [],
        }),
      }),
      ENV,
    )

    expect(response.status).toBe(200)
  })

  it('allows local Vite-to-Wrangler proxy write requests in development mode', async () => {
    const response = await handleRequest(
      new Request('http://localhost:8788/api/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:5175',
        },
        body: JSON.stringify({}),
      }),
      ENV,
    )
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(401)
    expect(data.error).toBe('未授权')
  })

  it('allows server-side write requests without Origin or Referer through to the normal auth gate', async () => {
    const response = await handleRequest(
      new Request('https://example.com/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      ENV,
    )
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(401)
    expect(data.error).toBe('未授权')
  })

  it('returns 404 for the removed runtime-config route in a ready environment', async () => {
    await expectRuntimeConfigNotFound(ENV)
  })

  it('returns 404 for runtime-config when admin is disabled', async () => {
    await expectRuntimeConfigNotFound({ ...ENV, ADMIN_DISABLED: 'true' })
  })

  it('returns 404 for runtime-config when environment validation fails', async () => {
    await expectRuntimeConfigNotFound({
      GH_TOKEN: 'placeholder',
      GH_REPO: 'owner/repo',
      GH_BRANCH: 'main',
      CONFIG_ENCRYPTION_KEY: '',
      DEVELOPMENT: '',
    })
  })

  it('does not trigger updates for authenticated non-JSON update requests', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await handleRequest(
      new Request('https://example.com/api/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Origin: 'https://example.com',
          Cookie: await authCookie(),
        },
        body: 'githubProxy=https://proxy.example',
      }),
      ENV,
    )
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(415)
    expect(data.error).toContain('application/json')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not check updates for authenticated non-JSON check-update requests', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await handleRequest(
      new Request('https://example.com/api/check-update', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Origin: 'https://example.com',
          Cookie: await authCookie(),
        },
        body: 'current=0.1.0',
      }),
      ENV,
    )
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(415)
    expect(data.error).toContain('application/json')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects cross-origin check-update requests before external fetches run', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await handleRequest(
      new Request('https://example.com/api/check-update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://attacker.example',
          Cookie: await authCookie(),
        },
        body: JSON.stringify({ current: '0.1.0' }),
      }),
      ENV,
    )

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires authentication before reading update status', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await handleRequest(
      new Request('https://example.com/api/update/status?since=2026-06-30T10%3A00%3A00.000Z'),
      ENV,
    )
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(401)
    expect(data.error).toBe('未授权')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires authentication before uploading files', async () => {
    const response = await handleRequest(
      new Request('https://example.com/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
        body: JSON.stringify({ path: 'public/music/track.mp3', content: 'QUJD' }),
      }),
      ENV,
    )
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(401)
    expect(data.error).toBe('未授权')
  })

  it('requires authentication before changing the password', async () => {
    const response = await handleRequest(
      new Request('https://example.com/api/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
        body: JSON.stringify({ current: 'old-password', next: 'new-password' }),
      }),
      ENV,
    )
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(401)
    expect(data.error).toBe('未授权')
  })

  it('requires authentication before testing the music api', async () => {
    const response = await handleRequest(
      new Request('https://example.com/api/test-music-api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
        body: JSON.stringify({ apiEndpoint: 'https://music-api.example' }),
      }),
      ENV,
    )
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(401)
    expect(data.error).toBe('未授权')
  })

  it('rejects an authenticated same-origin write without a CSRF token', async () => {
    const response = await handleRequest(
      new Request('https://example.com/api/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://example.com',
          Cookie: await authCookie(),
        },
        body: JSON.stringify({}),
      }),
      ENV,
    )
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(403)
    expect(data.error).toBe('CSRF 令牌无效或已过期')
  })

  it('returns 409 for setup once the admin password is initialized', async () => {
    // 开发模式走 admin-auth-store 内存路径,与 router 共享同一模块实例。
    const setup = await setupPassword('router-security-init', ENV)
    expect(setup.ok).toBe(true)

    const response = await handleRequest(
      new Request('https://example.com/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
        body: JSON.stringify({ password: 'another-password' }),
      }),
      ENV,
    )
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(409)
    expect(data.error).toBe('密码已初始化')
  })

  it('allows authenticated update status checks to call GitHub', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ workflow_runs: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await handleRequest(
      new Request('https://example.com/api/update/status?since=2026-06-30T10%3A00%3A00.000Z', {
        headers: { Cookie: await authCookie() },
      }),
      { ...ENV, GH_TOKEN: 'gh-test-token' },
    )
    const data = (await response.json()) as { run: null }

    expect(response.status).toBe(200)
    expect(data.run).toBeNull()
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(fetchMock).toHaveBeenCalled()
  })
})
