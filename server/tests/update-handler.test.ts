import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkUpdate, triggerUpdate } from '../core/update-handler'
import type { Env } from '../core/types'

const ENV: Env = {
  GH_TOKEN: 'gh-test-token',
  GH_REPO: 'owner/repo',
  GH_BRANCH: 'main',
  CONFIG_ENCRYPTION_KEY: 'test-encryption-key-not-used-in-update-handler',
}

function releaseResponse(tag: string): Response {
  return new Response(
    JSON.stringify({
      tag_name: tag,
      body: 'release notes',
      html_url: `https://github.com/abloom25/Meliora/releases/tag/${tag}`,
      published_at: '2026-06-23T00:00:00Z',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('server update handler', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('detects stable releases newer than prerelease builds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(releaseResponse('v0.2.0')))

    const response = await checkUpdate('0.2.0-rc1', ENV)
    const data = (await response.json()) as { hasUpdate: boolean; latestVersion: string }

    expect(response.status).toBe(200)
    expect(data.hasUpdate).toBe(true)
    expect(data.latestVersion).toBe('0.2.0')
  })

  it('does not attach the GitHub token to proxied update checks', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(releaseResponse('v0.3.0'))
    vi.stubGlobal('fetch', fetchMock)

    await checkUpdate('0.2.0', ENV, 'https://proxy.example.com/?url={url}')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://proxy.example.com/?url=https%3A%2F%2Fapi.github.com%2Frepos%2Fabloom25%2FMeliora%2Freleases%2Flatest',
      expect.objectContaining({
        headers: expect.not.objectContaining({ Authorization: expect.any(String) }),
      }),
    )
  })

  it('dispatches the update workflow through GitHub directly', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await triggerUpdate(ENV, 'https://proxy.example.com/?url={url}')

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/actions/workflows/update-from-upstream.yml/dispatches',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer gh-test-token' }),
      }),
    )
  })
})
