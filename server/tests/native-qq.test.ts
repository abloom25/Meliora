import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchQqLyrics } from '../core/lyrics/qq'

const ENCRYPTED = 'bb1db48dc814ca529e7b84a6f388ca053e39faa6800d93d41d20a6c5945f8eb97f0e0740bc3663e8'
const PLAIN = '[0,1000]one(0,500) two(500,500)'
const fetchMock = vi.fn<typeof fetch>()

function response(data: Record<string, unknown>, code = 0): Response {
  return Response.json({
    code: 0,
    req: { code, data: { songID: 123, qrc: 1, lyric: ENCRYPTED, ...data } },
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

describe('QQ native lyrics', () => {
  it('fetches numeric IDs and decodes QRC, translation and romanization', async () => {
    fetchMock.mockResolvedValue(response({ trans: '[00:00.00]一 二', roma: '[00:00.00]one two' }))
    const result = await fetchQqLyrics('123', new AbortController().signal)
    expect(result).toEqual({
      status: 'found',
      data: {
        source: 'qq',
        format: 'qrc',
        lyrics: PLAIN,
        translation: '[00:00.00]一 二',
        romanization: '[00:00.00]one two',
      },
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://u.y.qq.com/cgi-bin/musicu.fcg')
    const body = JSON.parse(String(init?.body)) as { req: { param: Record<string, unknown> } }
    expect(body.req.param).toMatchObject({ songId: 123, qrc: 1, crypt: 1 })
    expect(body.req.param).not.toHaveProperty('songMid')
    expect(init?.redirect).toBe('manual')
  })

  it('uses songMid for an alphanumeric MID, never a numeric coercion', async () => {
    fetchMock.mockResolvedValue(response({ songID: 987 }))
    expect((await fetchQqLyrics('003OUlho2HcRHC', new AbortController().signal)).status).toBe(
      'found',
    )
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      req: { param: Record<string, unknown> }
    }
    expect(body.req.param).toMatchObject({ songMid: '003OUlho2HcRHC' })
    expect(body.req.param).not.toHaveProperty('songId')
  })

  it.each([{ qrc: 0, lyric: '[00:00]plain' }, { lyric: '' }])(
    'returns missing only for an explicit absence %j',
    async (data) => {
      fetchMock.mockResolvedValue(response(data))
      await expect(fetchQqLyrics('123', new AbortController().signal)).resolves.toEqual({
        status: 'missing',
      })
    },
  )

  it.each([
    { lyric: 'invalid cipher' },
    { lyric: '[00:00.00]only lines despite qrc flag' },
    { lyric: null },
    { qrc: undefined },
    { songID: 321 },
  ])('does not negative-cache malformed or mismatched replies %j', async (data) => {
    fetchMock.mockResolvedValue(response(data))
    await expect(fetchQqLyrics('123', new AbortController().signal)).resolves.toEqual({
      status: 'unavailable',
    })
  })

  it('keeps valid primary lyrics when optional translation is malformed', async () => {
    fetchMock.mockResolvedValue(response({ trans: 'invalid' }))
    await expect(fetchQqLyrics('123', new AbortController().signal)).resolves.toEqual({
      status: 'found',
      data: { source: 'qq', format: 'qrc', lyrics: PLAIN },
    })
  })

  it.each([Response.json({ code: -1 }), response({}, 1000), new Response('', { status: 429 })])(
    'returns unavailable for upstream errors',
    async (reply) => {
      fetchMock.mockResolvedValue(reply)
      await expect(fetchQqLyrics('123', new AbortController().signal)).resolves.toEqual({
        status: 'unavailable',
      })
    },
  )

  it('does not dispatch malformed identifiers or an aborted request', async () => {
    for (const id of ['https://example.com', '0', '9007199254740992', 'short']) {
      expect((await fetchQqLyrics(id, new AbortController().signal)).status).toBe('unavailable')
    }
    const controller = new AbortController()
    controller.abort()
    expect((await fetchQqLyrics('123', controller.signal)).status).toBe('unavailable')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
