import { afterEach, describe, expect, it, vi } from 'vitest'
import { utf8ToBase64, writeFile } from '../core/github'
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
