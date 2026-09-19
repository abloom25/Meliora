import { describe, expect, it, vi } from 'vitest'
import { guardDevMusicProxy, isLocalConfigWriteAllowed } from '../../scripts/dev-request-guards'

function request(
  headers: Record<string, string | string[] | undefined>,
  url = '/__meliora-dev/music/api?type=lrc&id=123',
  method = 'GET',
) {
  return { headers, url, method }
}

describe('development request guards', () => {
  it.each(['localhost:5175', '192.168.1.10:5175', '[::1]:5175'])(
    'accepts same-origin JSON config writes from %s',
    (host) => {
      expect(
        isLocalConfigWriteAllowed(
          request({
            host,
            origin: `http://${host}`,
            'content-type': 'application/json; charset=utf-8',
          }),
        ),
      ).toBe(true)
      expect(
        isLocalConfigWriteAllowed(
          request({ host, referer: `http://${host}/admin`, 'content-type': 'application/json' }),
        ),
      ).toBe(true)
    },
  )

  it.each([
    { origin: 'https://other.example' },
    { origin: 'null' },
    { origin: 'http://localhost:5176' },
    { origin: 'invalid' },
    { origin: undefined },
    { 'sec-fetch-site': 'cross-site' },
    { 'content-type': 'text/plain' },
    { 'content-type': undefined },
  ])('rejects untrusted config writes: %j', (overrides) => {
    expect(
      isLocalConfigWriteAllowed(
        request({
          host: 'localhost:5175',
          origin: 'http://localhost:5175',
          'content-type': 'application/json',
          ...overrides,
        }),
      ),
    ).toBe(false)
  })

  it.each([
    ['/__meliora-dev/music/api?type=url&id=123', 'GET', 0],
    ['/__meliora-dev/music/api', 'HEAD', 0],
    ['/__meliora-dev/music/api', 'POST', 405],
    ['/__meliora-dev/music/api', 'DELETE', 405],
    ['/__meliora-dev/music/other', 'GET', 404],
    ['/__meliora-dev/music/api/../other', 'GET', 404],
    ['/__meliora-dev/music/api%2f..%2fother', 'GET', 404],
    ['/__meliora-dev/music//other.example/api', 'GET', 404],
    ['/api/setup-status', 'GET', 0],
  ])('guards %s (%s)', (url, method, status) => {
    const response = { statusCode: 200, end: vi.fn(), setHeader: vi.fn() }
    const next = vi.fn()
    guardDevMusicProxy(new URL('https://music.example/api'))(
      request({}, url, method),
      response,
      next,
    )
    expect(next).toHaveBeenCalledTimes(status === 0 ? 1 : 0)
    expect(response.end).toHaveBeenCalledTimes(status === 0 ? 0 : 1)
    if (status) expect(response.statusCode).toBe(status)
    if (status === 405) expect(response.setHeader).toHaveBeenCalledWith('Allow', 'GET, HEAD')
  })
})
