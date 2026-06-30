import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCookieHeader, signToken } from '../core/auth'
import { handleRequest } from '../core/router'
import type { Env } from '../core/types'

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
