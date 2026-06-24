import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleRequest } from '../core/router'
import type { Env } from '../core/types'

const ENV: Env = {
  GH_TOKEN: 'placeholder',
  GH_REPO: 'owner/repo',
  GH_BRANCH: 'main',
  CONFIG_ENCRYPTION_KEY: '',
}

describe('router security gates', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requires authentication before checking updates', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await handleRequest(
      new Request(
        'https://example.com/api/check-update?current=0.1.0&githubProxy=https://proxy.test',
      ),
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
})
