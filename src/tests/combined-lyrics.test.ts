import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCombinedLyrics } from '../services/lyrics'
import { resetWordLyricsCache } from '../services/lyrics-db'

const TTML = `<tt><body><div><p begin="00:01.000" end="00:02.000"><span begin="00:01.000" end="00:01.400">你</span><span begin="00:01.400" end="00:02.000">好</span></p></div></body></tt>`

function routeFetch(routes: Record<string, Response | Error>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    for (const [needle, value] of Object.entries(routes)) {
      if (!url.includes(needle)) continue
      if (value instanceof Error) throw value
      return value.clone()
    }
    return new Response('', { status: 404 })
  })
}

describe('loadCombinedLyrics', () => {
  beforeEach(() => {
    resetWordLyricsCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prefers the word timeline over the plain lyrics when the database has a hit', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        'ncm-lyrics': new Response(TTML, { status: 200 }),
        'plain-1.lrc': new Response('[00:01.00]你好', { status: 200 }),
      }),
    )

    const lines = await loadCombinedLyrics({
      lyricsUrl: 'https://cdn.example.com/plain-1.lrc',
      wordQuery: { platform: 'netease', id: '1' },
    })

    expect(lines[0]?.wordSource).toBe('native')
    expect(lines[0]?.words).toHaveLength(2)
  })

  it('borrows translations from the plain lyrics because TTML often has none', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        'ncm-lyrics': new Response(TTML, { status: 200 }),
        'plain-2.lrc': new Response('[00:01.00]你好 (hello)', { status: 200 }),
      }),
    )

    const lines = await loadCombinedLyrics({
      lyricsUrl: 'https://cdn.example.com/plain-2.lrc',
      wordQuery: { platform: 'netease', id: '2' },
    })

    expect(lines[0]?.translation).toBe('hello')
  })

  it('leaves plain lyrics without a word timeline when the database misses', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({ 'plain-3.lrc': new Response('[00:01.00]你好世界', { status: 200 }) }),
    )

    const lines = await loadCombinedLyrics({
      lyricsUrl: 'https://cdn.example.com/plain-3.lrc',
      wordQuery: { platform: 'netease', id: '3' },
    })

    // 没命中逐字库就老老实实整行高亮,不猜音节
    expect(lines[0]).toMatchObject({ time: 1, text: '你好世界' })
    expect(lines[0]?.words).toBeUndefined()
    expect(lines[0]?.wordSource).toBeUndefined()
  })

  it('keeps the word timeline even when the plain lyrics request fails', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        'ncm-lyrics': new Response(TTML, { status: 200 }),
        'plain-4.lrc': new Error('offline'),
      }),
    )

    const lines = await loadCombinedLyrics({
      lyricsUrl: 'https://cdn.example.com/plain-4.lrc',
      wordQuery: { platform: 'netease', id: '4' },
    })

    expect(lines[0]?.wordSource).toBe('native')
  })

  it('surfaces the plain lyrics failure when there is no word timeline to fall back on', async () => {
    vi.stubGlobal('fetch', routeFetch({ 'plain-5.lrc': new Error('offline') }))

    await expect(
      loadCombinedLyrics({
        lyricsUrl: 'https://cdn.example.com/plain-5.lrc',
        wordQuery: { platform: 'netease', id: '5' },
      }),
    ).rejects.toThrow('offline')
  })

  it('never queries the database without a platform id', async () => {
    const fetchMock = routeFetch({
      'plain-6.lrc': new Response('[00:01.00]你好', { status: 200 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await loadCombinedLyrics({ lyricsUrl: 'https://cdn.example.com/plain-6.lrc' })

    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes('ncm-lyrics'))).toBe(
      true,
    )
  })
})
