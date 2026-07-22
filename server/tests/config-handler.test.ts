import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../core/types'
import { encryptString } from '../core/crypto'
import { GitHubWriteError } from '../core/github'

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
  getBranchSnapshot: vi.fn(),
  createBlob: vi.fn(),
  listTreePaths: vi.fn(),
  commitTreeAtomically: vi.fn(),
}))

vi.mock('../core/github', async (importOriginal) => {
  const original = await importOriginal<typeof import('../core/github')>()
  return {
    ...original,
    readFile: githubMocks.readFile,
    writeFile: githubMocks.writeFile,
    getBranchSnapshot: githubMocks.getBranchSnapshot,
    createBlob: githubMocks.createBlob,
    listTreePaths: githubMocks.listTreePaths,
    commitTreeAtomically: githubMocks.commitTreeAtomically,
  }
})

describe('config-handler', () => {
  beforeEach(() => {
    vi.resetModules()
    githubMocks.readFile.mockReset()
    githubMocks.writeFile.mockReset()
    githubMocks.getBranchSnapshot.mockReset()
    githubMocks.createBlob.mockReset()
    githubMocks.listTreePaths.mockReset()
    githubMocks.commitTreeAtomically.mockReset()
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

  it('commits config, staged uploads, and removed managed assets in one tree update', async () => {
    const previous = {
      siteName: 'Meliora',
      siteIcon: './icon.png',
      apiEndpoint: '',
      playlists: [],
      localTracks: [
        {
          id: 'old',
          title: 'Old track',
          artist: 'Artist',
          audio: './music/old/audio.mp3',
          cover: './music/old/cover.jpg',
          lyrics: './music/old/missing.lrc',
        },
      ],
    }
    const encrypted = await encryptString(JSON.stringify(previous), ENV)
    githubMocks.getBranchSnapshot.mockResolvedValue({
      commitSha: 'commit-base',
      treeSha: 'tree-base',
    })
    githubMocks.readFile.mockResolvedValue({ content: encrypted, sha: 'old-config-blob' })
    githubMocks.listTreePaths.mockResolvedValue({
      paths: new Set([
        'public/icon.png',
        'public/music/old/audio.mp3',
        'public/music/old/cover.jpg',
      ]),
      truncated: false,
    })
    githubMocks.createBlob.mockResolvedValue('c'.repeat(40))
    githubMocks.commitTreeAtomically.mockResolvedValue('commit-next')
    const { putConfig } = await import('../core/config-handler')

    const response = await putConfig(
      {
        config: {
          siteName: 'Meliora',
          siteIcon: './icon.webp',
          apiEndpoint: '',
          playlists: [],
          localTracks: [],
        },
        uploads: [{ path: 'public/icon.webp', blobSha: 'a'.repeat(40) }],
      },
      ENV,
    )
    const data = (await response.json()) as { sha?: string; committedUploads?: number }

    expect(response.status).toBe(200)
    expect(data).toEqual({ sha: 'commit-next', committedUploads: 1 })
    expect(githubMocks.readFile).toHaveBeenCalledWith('public/config.json', ENV, 'commit-base')
    expect(githubMocks.commitTreeAtomically).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ path: 'public/config.json', sha: 'c'.repeat(40) }),
        expect.objectContaining({ path: 'public/icon.webp', sha: 'a'.repeat(40) }),
        expect.objectContaining({ path: 'public/icon.png', sha: null }),
        expect.objectContaining({ path: 'public/music/old/audio.mp3', sha: null }),
        expect.objectContaining({ path: 'public/music/old/cover.jpg', sha: null }),
      ]),
      ENV,
      expect.stringContaining('update config and assets'),
      { commitSha: 'commit-base', treeSha: 'tree-base' },
    )
    const entries = githubMocks.commitTreeAtomically.mock.calls[0]![0] as Array<{
      path: string
      sha: string | null
    }>
    expect(entries).not.toContainEqual(
      expect.objectContaining({ path: 'public/music/old/missing.lrc', sha: null }),
    )
  })

  it('rejects a staged blob that is not referenced by the new config', async () => {
    const { putConfig } = await import('../core/config-handler')
    const response = await putConfig(
      {
        config: {
          siteName: 'Meliora',
          apiEndpoint: '',
          playlists: [],
          localTracks: [],
        },
        uploads: [{ path: 'public/music/orphan/audio.mp3', blobSha: 'a'.repeat(40) }],
      },
      ENV,
    )
    const data = (await response.json()) as { error?: string; details?: string[] }

    expect(response.status).toBe(400)
    expect(data.error).toContain('暂存文件校验失败')
    expect(data.details?.join(' ')).toContain('未被当前配置引用')
    expect(githubMocks.getBranchSnapshot).not.toHaveBeenCalled()
  })

  it('rejects a malformed staged upload collection instead of silently dropping files', async () => {
    const { putConfig } = await import('../core/config-handler')
    const response = await putConfig(
      {
        config: {
          siteName: 'Meliora',
          apiEndpoint: '',
          playlists: [],
          localTracks: [],
        },
        uploads: { path: 'public/icon.png', blobSha: 'a'.repeat(40) },
      },
      ENV,
    )
    const data = (await response.json()) as { details?: string[] }

    expect(response.status).toBe(400)
    expect(data.details).toContain('uploads 必须是数组')
    expect(githubMocks.getBranchSnapshot).not.toHaveBeenCalled()
  })

  it('keeps the branch unchanged and reports a conflict when the atomic ref update loses a race', async () => {
    githubMocks.getBranchSnapshot.mockResolvedValue({
      commitSha: 'commit-base',
      treeSha: 'tree-base',
    })
    githubMocks.readFile.mockResolvedValue(null)
    githubMocks.createBlob.mockResolvedValue('c'.repeat(40))
    githubMocks.commitTreeAtomically.mockRejectedValue(
      new GitHubWriteError('non-fast-forward', 422, 'Reference update failed'),
    )
    const { putConfig } = await import('../core/config-handler')

    const response = await putConfig(
      {
        siteName: 'Meliora',
        apiEndpoint: '',
        playlists: [],
        localTracks: [],
      },
      ENV,
    )
    const data = (await response.json()) as { error?: string }

    expect(response.status).toBe(409)
    expect(data.error).toContain('其他操作修改')
  })
})
