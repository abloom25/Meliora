import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../core/types'

const STRONG_KEY = 'meliora-prod-key-A7f3N9q2R8s5T1u4V6w0'
const ENV: Env = {
  GH_TOKEN: 'ghp_real_token_for_test',
  GH_REPO: 'owner/repo',
  GH_BRANCH: 'main',
  CONFIG_ENCRYPTION_KEY: STRONG_KEY,
}

const githubMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock('../core/github', async (importOriginal) => {
  const original = await importOriginal<typeof import('../core/github')>()
  return {
    ...original,
    readFile: githubMocks.readFile,
    writeFile: githubMocks.writeFile,
  }
})

describe('config-handler', () => {
  beforeEach(() => {
    vi.resetModules()
    githubMocks.readFile.mockReset()
    githubMocks.writeFile.mockReset()
  })

  it('returns the default config only when config.json does not exist', async () => {
    githubMocks.readFile.mockResolvedValue(null)
    const { getConfig } = await import('../core/config-handler')

    const response = await getConfig(ENV)
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data).toMatchObject({ siteName: 'Meliora', playlists: [], localTracks: [] })
  })

  it('fails closed when GitHub config loading fails', async () => {
    githubMocks.readFile.mockRejectedValue(new Error('GitHub unavailable'))
    const { getConfig } = await import('../core/config-handler')

    const response = await getConfig(ENV)
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(502)
    expect(data.error).toContain('读取配置失败')
  })

  it('fails closed when production config.json is plaintext', async () => {
    githubMocks.readFile.mockResolvedValue({
      content: JSON.stringify({
        siteName: 'Plaintext',
        apiEndpoint: '',
        playlists: [],
        localTracks: [],
      }),
      sha: 'sha',
    })
    const { getConfig } = await import('../core/config-handler')

    const response = await getConfig(ENV)
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(409)
    expect(data.error).toContain('有效密文')
  })
})
