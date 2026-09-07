import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORD_LYRICS_MIRRORS } from '../config/lyrics'
import { hasCachedWordLyrics, loadWordLyrics, resetWordLyricsCache } from '../services/lyrics-db'

const TTML = `<tt><body><div><p begin="00:01.000" end="00:02.000"><span begin="00:01.000" end="00:01.400">你</span><span begin="00:01.400" end="00:02.000">好</span></p></div></body></tt>`

function response(body: string, status = 200) {
  return new Response(body, { status })
}

describe('loadWordLyrics', () => {
  beforeEach(() => {
    resetWordLyricsCache()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns a native syllable timeline on a hit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(TTML))
    vi.stubGlobal('fetch', fetchMock)

    const lines = await loadWordLyrics({ platform: 'netease', id: '123' })

    expect(lines?.[0]?.wordSource).toBe('native')
    expect(lines?.[0]?.words).toHaveLength(2)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${WORD_LYRICS_MIRRORS[0]!.baseUrl}/ncm-lyrics/123.ttml`,
    )
  })

  it('uses the QQ folder for tencent tracks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(TTML))
    vi.stubGlobal('fetch', fetchMock)

    await loadWordLyrics({ platform: 'tencent', id: '004d5o8E' })

    expect(fetchMock.mock.calls[0]?.[0]).toContain('/qq-lyrics/004d5o8E.ttml')
  })

  it('stops asking other mirrors once one answers 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response('', 404))
    vi.stubGlobal('fetch', fetchMock)

    expect(await loadWordLyrics({ platform: 'netease', id: '404' })).toBeNull()
    // 404 是"库里没有"的确定答案:每种格式只问一个镜像
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls through to the next mirror when one is unreachable', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(response(TTML))
    vi.stubGlobal('fetch', fetchMock)

    const lines = await loadWordLyrics({ platform: 'netease', id: '123' })

    expect(lines).not.toBeNull()
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `${WORD_LYRICS_MIRRORS[1]!.baseUrl}/ncm-lyrics/123.ttml`,
    )
  })

  it('gives up on every format once all mirrors are unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)

    expect(await loadWordLyrics({ platform: 'netease', id: '123' })).toBeNull()
    // 全站不可达时不再试第二种格式,直接把主歌词的加载让出去
    expect(fetchMock).toHaveBeenCalledTimes(WORD_LYRICS_MIRRORS.length)
    expect(warn).toHaveBeenCalled()
  })

  it('falls back to the next format when the file has no syllables', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response('[00:01.00]plain lrc'))
      .mockResolvedValueOnce(response('[1000,900](1000,400,0)你(1400,500,0)好'))
    vi.stubGlobal('fetch', fetchMock)

    const lines = await loadWordLyrics({ platform: 'netease', id: '123' })

    expect(lines?.[0]?.wordSource).toBe('native')
    expect(fetchMock.mock.calls[1]?.[0]).toContain('.yrc')
  })

  it('shares one request between concurrent callers and caches the result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(TTML))
    vi.stubGlobal('fetch', fetchMock)

    const [first, second] = await Promise.all([
      loadWordLyrics({ platform: 'netease', id: '123' }),
      loadWordLyrics({ platform: 'netease', id: '123' }),
    ])

    expect(first).toBe(second)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(hasCachedWordLyrics({ platform: 'netease', id: '123' })).toBe(true)

    await loadWordLyrics({ platform: 'netease', id: '123' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caches misses so every track change does not re-probe the mirrors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response('', 404))
    vi.stubGlobal('fetch', fetchMock)

    await loadWordLyrics({ platform: 'netease', id: '404' })
    const callsAfterFirst = fetchMock.mock.calls.length
    await loadWordLyrics({ platform: 'netease', id: '404' })

    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst)
  })

  it('resolves to null instead of rejecting when the caller aborts', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )

    const pending = loadWordLyrics({ platform: 'netease', id: '123' }, controller.signal)
    controller.abort()

    await expect(pending).resolves.toBeNull()
  })

  it('skips the lookup entirely without an id', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(await loadWordLyrics({ platform: 'netease', id: '' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
