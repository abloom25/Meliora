import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptNeteaseParams, md5Hex } from '../core/lyrics/netease-crypto'
import { fetchNeteaseLyrics } from '../core/lyrics/netease'
import { fetchLyricsJson } from '../core/lyrics/upstream'

vi.mock('../core/lyrics/upstream', () => ({ fetchLyricsJson: vi.fn() }))

const YRC = '[1000,1000](1000,500,0)测(1500,500,0)试'
const EAPI_PATH = '/api/song/lyric/v1'

function nodeEapiParams(data: object): string {
  const text = JSON.stringify(data)
  const digest = createHash('md5').update(`nobody${EAPI_PATH}use${text}md5forencrypt`).digest('hex')
  const cipher = createCipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8'), null)
  return Buffer.concat([
    cipher.update(`${EAPI_PATH}-36cd479b6b5-${text}-36cd479b6b5-${digest}`),
    cipher.final(),
  ])
    .toString('hex')
    .toUpperCase()
}

function decryptParams(body: string): string {
  const params = new URLSearchParams(body).get('params') ?? ''
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8'), null)
  return Buffer.concat([decipher.update(Buffer.from(params, 'hex')), decipher.final()]).toString()
}

describe('NetEase EAPI encoding without Node runtime dependencies', () => {
  it.each([
    '',
    'a',
    'abc',
    'message digest',
    '测试🎵',
    ...[55, 56, 63, 64, 65, 120].map((n) => 'x'.repeat(n)),
  ])('matches the MD5 reference for %j', (text) => {
    expect(md5Hex(text)).toBe(createHash('md5').update(text).digest('hex'))
  })

  it.each([{}, { id: '1361348080' }, { text: '多字节🎵'.repeat(20) }, { text: 'a'.repeat(111) }])(
    'matches AES-ECB reference including padding and UTF-8',
    async (data) => {
      expect(await encryptNeteaseParams(EAPI_PATH, data)).toBe(nodeEapiParams(data))
    },
  )
})

describe('native NetEase lyrics', () => {
  beforeEach(() => {
    vi.mocked(fetchLyricsJson).mockReset()
  })

  it('requests the exact song and returns YRC with aligned translations and romanization', async () => {
    vi.mocked(fetchLyricsJson).mockResolvedValue({
      code: 200,
      yrc: { lyric: YRC },
      ytlrc: { lyric: '[00:01.000]测试翻译' },
      tlyric: { lyric: '[00:02.000]旧翻译' },
      yromalrc: { lyric: '[00:01.000]ce shi' },
      romalrc: { lyric: '[00:02.000]old' },
    })
    const signal = new AbortController().signal
    expect(await fetchNeteaseLyrics('1361348080', signal)).toEqual({
      status: 'found',
      data: {
        source: 'netease',
        format: 'yrc',
        lyrics: YRC,
        translation: '[00:01.000]测试翻译',
        romanization: '[00:01.000]ce shi',
      },
    })
    const [url, request, forwardedSignal] = vi.mocked(fetchLyricsJson).mock.calls[0]
    expect(url).toBe('https://interface3.music.163.com/eapi/song/lyric/v1')
    expect(forwardedSignal).toBe(signal)
    expect(request.method).toBe('POST')
    expect(new Headers(request.headers).has('Cookie')).toBe(false)
    const envelope = decryptParams(request.body as string).split('-36cd479b6b5-')
    expect(envelope[0]).toBe(EAPI_PATH)
    expect(JSON.parse(envelope[1])).toEqual({
      id: '1361348080',
      cp: false,
      tv: 0,
      lv: 0,
      rv: 0,
      kv: 0,
      yv: 0,
      ytv: 0,
      yrv: 0,
    })
  })

  it('falls back to original translation and romanization when aligned variants are empty', async () => {
    vi.mocked(fetchLyricsJson).mockResolvedValue({
      code: 200,
      yrc: { lyric: YRC },
      ytlrc: { lyric: ' ' },
      tlyric: { lyric: '[00:01.000]翻译' },
      romalrc: { lyric: '[00:01.000]ce shi' },
    })
    expect(await fetchNeteaseLyrics('1', new AbortController().signal)).toMatchObject({
      status: 'found',
      data: { translation: '[00:01.000]翻译', romanization: '[00:01.000]ce shi' },
    })
  })

  it.each([
    { code: 200, yrc: { lyric: '' } },
    { code: 200, lrc: { lyric: '[00:01.000]普通歌词' } },
    { code: 200, nolyric: true },
    { code: 200, uncollected: true },
  ])('recognizes explicit absence of word timing: %j', async (response) => {
    vi.mocked(fetchLyricsJson).mockResolvedValue(response)
    expect(await fetchNeteaseLyrics('1', new AbortController().signal)).toEqual({
      status: 'missing',
    })
  })

  it.each([
    null,
    [],
    {},
    { code: 200 },
    { code: 429 },
    { code: 200, yrc: { lyric: '[00:01.000]not YRC' } },
    { code: 200, yrc: { lyric: 123 } },
    { code: 200, yrc: { lyric: 123 }, lrc: { lyric: '[00:01.000]普通歌词' } },
    { code: 200, yrc: null },
  ])('keeps malformed and failed responses retryable: %j', async (response) => {
    vi.mocked(fetchLyricsJson).mockResolvedValue(response)
    expect(await fetchNeteaseLyrics('1', new AbortController().signal)).toEqual({
      status: 'unavailable',
    })
  })

  it('handles transport failures', async () => {
    vi.mocked(fetchLyricsJson).mockRejectedValue(new Error('Upstream unavailable'))
    expect(await fetchNeteaseLyrics('1', new AbortController().signal)).toEqual({
      status: 'unavailable',
    })
  })

  it.each(['', '0', '-1', 'abc', '123/456', '1'.repeat(21)])(
    'does not request invalid song ID %j',
    async (id) => {
      expect(await fetchNeteaseLyrics(id, new AbortController().signal)).toEqual({
        status: 'unavailable',
      })
      expect(fetchLyricsJson).not.toHaveBeenCalled()
    },
  )

  it('does not start work for an already cancelled request', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await fetchNeteaseLyrics('1', controller.signal)).toEqual({ status: 'unavailable' })
    expect(fetchLyricsJson).not.toHaveBeenCalled()
  })

  it('does not publish a response after cancellation', async () => {
    const controller = new AbortController()
    vi.mocked(fetchLyricsJson).mockImplementation(async () => {
      controller.abort()
      return { code: 200, yrc: { lyric: YRC } }
    })
    expect(await fetchNeteaseLyrics('1', controller.signal)).toEqual({ status: 'unavailable' })
  })
})
