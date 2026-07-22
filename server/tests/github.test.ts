import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  commitTreeAtomically,
  createBlob,
  getBranchSnapshot,
  readFile,
  utf8ToBase64,
  writeFile,
} from '../core/github'
import type { Env } from '../core/types'

const ENV: Env = {
  GH_TOKEN: 'ghp_real_token_for_test',
  GH_REPO: 'owner/repo',
  GH_BRANCH: 'main',
  CONFIG_ENCRYPTION_KEY: 'x'.repeat(32),
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('utf8ToBase64', () => {
  it('encodes ASCII identically to btoa', () => {
    expect(utf8ToBase64('hello')).toBe(btoa('hello'))
  })

  it('encodes non-ASCII UTF-8 round-trippably without throwing', () => {
    const text = '配置加密密钥'
    const encoded = utf8ToBase64(text)
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
    expect(new TextDecoder().decode(bytes)).toBe(text)
  })
})

describe('writeFile content encoding contract', () => {
  it('passes base64 content through verbatim without double-encoding', async () => {
    const base64 = btoa('raw-file-bytes')
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ commit: { sha: 'commit-sha' } }), { status: 200 }),
      )

    await writeFile('public/config.json', base64, ENV, 'chore: test')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse((init as RequestInit).body as string) as { content: string }
    // 回归守护:writeFile 不得对已 base64 编码的 content 再次编码,
    // 否则生产环境上传/配置写入会产生双重编码导致文件损坏。
    expect(body.content).toBe(base64)
  })
})

describe('Git Data atomic commit helpers', () => {
  it('pins the branch head and base tree before an atomic save', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: { sha: 'commit-base' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tree: { sha: 'tree-base' } })))

    await expect(getBranchSnapshot(ENV)).resolves.toEqual({
      commitSha: 'commit-base',
      treeSha: 'tree-base',
    })

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://api.github.com/repos/owner/repo/git/ref/heads/main',
    )
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      'https://api.github.com/repos/owner/repo/git/commits/commit-base',
    )
  })

  it('can read config from the pinned commit instead of a moving branch name', async () => {
    const encoded = btoa('encrypted-config')
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ content: encoded, encoding: 'base64', sha: 'config-blob' })),
      )

    await expect(readFile('public/config.json', ENV, 'commit-base')).resolves.toEqual({
      content: 'encrypted-config',
      sha: 'config-blob',
    })
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://api.github.com/repos/owner/repo/contents/public/config.json?ref=commit-base',
    )
  })

  it('stages base64 content as an unattached Git blob', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ sha: 'a'.repeat(40) }), { status: 201 }))

    await expect(createBlob('YmluYXJ5', ENV)).resolves.toBe('a'.repeat(40))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://api.github.com/repos/owner/repo/git/blobs')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      content: 'YmluYXJ5',
      encoding: 'base64',
    })
  })

  it('creates one tree and commit before advancing the branch without force', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'tree-next' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'commit-next' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: { sha: 'commit-next' } })))

    const entries = [
      {
        path: 'public/config.json',
        mode: '100644' as const,
        type: 'blob' as const,
        sha: 'b'.repeat(40),
      },
      {
        path: 'public/music/old/audio.mp3',
        mode: '100644' as const,
        type: 'blob' as const,
        sha: null,
      },
    ]
    const sha = await commitTreeAtomically(entries, ENV, 'chore: atomic save', {
      commitSha: 'commit-base',
      treeSha: 'tree-base',
    })

    expect(sha).toBe('commit-next')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      base_tree: 'tree-base',
      tree: entries,
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      message: 'chore: atomic save',
      tree: 'tree-next',
      parents: ['commit-base'],
    })
    expect(String(fetchMock.mock.calls[2]![0])).toBe(
      'https://api.github.com/repos/owner/repo/git/refs/heads/main',
    )
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toEqual({
      sha: 'commit-next',
      force: false,
    })
  })
})
