import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkUpdate, getUpdateStatus, triggerUpdate } from '../core/update-handler'
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

function tagsResponse(tags: string[]): Response {
  return new Response(JSON.stringify(tags.map((name) => ({ name }))), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('server update handler', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('detects stable releases newer than prerelease builds', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(releaseResponse('v0.2.0'))
        .mockResolvedValueOnce(tagsResponse(['v0.2.0'])),
    )

    const response = await checkUpdate('0.2.0-rc1', ENV)
    const data = (await response.json()) as { hasUpdate: boolean; latestVersion: string }

    expect(response.status).toBe(200)
    expect(data.hasUpdate).toBe(true)
    expect(data.latestVersion).toBe('0.2.0')
  })

  it('does not attach the GitHub token to proxied update checks', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(releaseResponse('v0.3.0'))
      .mockResolvedValueOnce(tagsResponse(['v0.3.0']))
    vi.stubGlobal('fetch', fetchMock)

    await checkUpdate('0.2.0', ENV, 'https://proxy.example.com/?url={url}')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://proxy.example.com/?url=https%3A%2F%2Fapi.github.com%2Frepos%2Fabloom25%2FMeliora%2Freleases%2Flatest',
      expect.objectContaining({
        headers: expect.not.objectContaining({ Authorization: expect.any(String) }),
      }),
    )
  })

  it('uses semver ordering for tag fallback and ignores invalid tags', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(tagsResponse(['latest', 'v0.9.0', 'v0.10.0']))
    vi.stubGlobal('fetch', fetchMock)

    const response = await checkUpdate('0.8.0', ENV)
    const data = (await response.json()) as { hasUpdate: boolean; latestVersion: string }

    expect(response.status).toBe(200)
    expect(data.hasUpdate).toBe(true)
    expect(data.latestVersion).toBe('0.10.0')
  })

  it('ignores prerelease updates for stable builds unless opted in', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(releaseResponse('v0.2.0'))
      .mockResolvedValueOnce(tagsResponse(['v0.3.0-rc.1', 'v0.2.0']))
    vi.stubGlobal('fetch', fetchMock)

    const response = await checkUpdate('0.2.0', ENV)
    const data = (await response.json()) as { hasUpdate: boolean; latestVersion: string }

    expect(response.status).toBe(200)
    expect(data.hasUpdate).toBe(false)
    expect(data.latestVersion).toBe('0.2.0')
  })

  it('allows stable builds to receive prerelease updates when opted in', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(releaseResponse('v0.2.0'))
      .mockResolvedValueOnce(tagsResponse(['v0.3.0-rc.1', 'v0.2.0']))
    vi.stubGlobal('fetch', fetchMock)

    const response = await checkUpdate('0.2.0', ENV, undefined, true)
    const data = (await response.json()) as { hasUpdate: boolean; latestVersion: string }

    expect(response.status).toBe(200)
    expect(data.hasUpdate).toBe(true)
    expect(data.latestVersion).toBe('0.3.0-rc.1')
  })

  it('rejects private GitHub proxy URLs', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await checkUpdate('0.2.0', ENV, 'http://127.0.0.1:8080/{url}')
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(400)
    expect(data.error).toContain('公网')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects workflow dispatch without a usable GitHub token', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await triggerUpdate({ ...ENV, GH_TOKEN: 'placeholder' })
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(400)
    expect(data.error).toContain('Actions: write')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('dispatches the update workflow through GitHub directly', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await triggerUpdate(
      ENV,
      'https://proxy.example.com/?url={url}',
      'v0.3.0',
      true,
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/actions/workflows/update-from-upstream.yml/dispatches',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer gh-test-token' }),
      }),
    )
    const data = (await response.json()) as { triggeredAt?: string; triggerId?: string }
    expect(data.triggeredAt).toBeTruthy()
    expect(data.triggerId).toBeTruthy()
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      ref: 'main',
      inputs: {
        upstream_repo: 'abloom25/Meliora',
        github_proxy: 'https://proxy.example.com/?url={url}',
        target_tag: 'v0.3.0',
        allow_prerelease: 'true',
        trigger_id: data.triggerId,
      },
    })
  })

  it('rejects invalid target tags before dispatching updates', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await triggerUpdate(ENV, undefined, 'release-latest')
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(400)
    expect(data.error).toContain('目标版本号无效')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns locating update status when no workflow run is available yet', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ workflow_runs: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await getUpdateStatus(ENV, '2026-06-30T10:00:01.000Z')
    const data = (await response.json()) as { run: null; message: string }

    expect(response.status).toBe(200)
    expect(data.run).toBeNull()
    expect(data.message).toContain('等待')
  })

  it('normalizes successful workflow run status', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 123,
              run_number: 7,
              run_attempt: 1,
              event: 'workflow_dispatch',
              head_branch: 'main',
              status: 'completed',
              conclusion: 'success',
              created_at: '2026-06-30T10:00:05.000Z',
              updated_at: '2026-06-30T10:05:00.000Z',
              html_url: 'https://github.com/owner/repo/actions/runs/123',
              head_sha: 'abc123',
              display_title: 'Update from upstream v0.3.0 dispatch-123',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await getUpdateStatus(ENV, '2026-06-30T10:00:02.000Z', 'dispatch-123')
    const data = (await response.json()) as {
      run: { displayStatus: string; latestCommitUrl: string }
      message: string
    }

    expect(response.status).toBe(200)
    expect(data.run.displayStatus).toBe('success')
    expect(data.run.latestCommitUrl).toBe('https://github.com/owner/repo/commit/abc123')
    expect(data.message).toContain('更新完成')
  })

  it('ignores adjacent workflow runs when trigger id does not match', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 125,
              run_number: 9,
              event: 'workflow_dispatch',
              head_branch: 'main',
              status: 'completed',
              conclusion: 'success',
              created_at: '2026-06-30T10:00:05.000Z',
              updated_at: '2026-06-30T10:05:00.000Z',
              html_url: 'https://github.com/owner/repo/actions/runs/125',
              display_title: 'Update from upstream v0.3.0 another-dispatch',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await getUpdateStatus(ENV, '2026-06-30T10:00:03.000Z', 'dispatch-123')
    const data = (await response.json()) as { run: null; message: string }

    expect(response.status).toBe(200)
    expect(data.run).toBeNull()
    expect(data.message).toContain('等待')
  })

  it('normalizes failed workflow run status with a failure message', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 124,
              run_number: 8,
              event: 'workflow_dispatch',
              head_branch: 'main',
              status: 'completed',
              conclusion: 'failure',
              created_at: '2026-06-30T10:00:05.000Z',
              updated_at: '2026-06-30T10:05:00.000Z',
              html_url: 'https://github.com/owner/repo/actions/runs/124',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await getUpdateStatus(ENV, '2026-06-30T10:00:00.000Z')
    const data = (await response.json()) as {
      run: { displayStatus: string }
      failure?: { message: string }
    }

    expect(response.status).toBe(200)
    expect(data.run.displayStatus).toBe('failed')
    expect(data.failure?.message).toContain('目标分支未写入更新')
  })
})
