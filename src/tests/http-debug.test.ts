import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runtimeResourceLabel,
  subscribeRuntimeHttp,
  type RuntimeHttpRequest,
} from '../core/diagnostics/runtime-debug'
import { httpFetch, setHttpFetcher, type HttpFetcher } from '../services/http'

const detach: Array<() => void> = []
afterEach(() => {
  detach.splice(0).forEach((stop) => stop())
  setHttpFetcher(null)
  vi.restoreAllMocks()
})

function observe(): RuntimeHttpRequest[] {
  const events: RuntimeHttpRequest[] = []
  detach.push(subscribeRuntimeHttp((event) => events.push({ ...event })))
  return events
}

describe('HTTP diagnostic observation', () => {
  it('keeps the original promise and init and does no observation work without listeners', () => {
    const pending = Promise.resolve(new Response('untouched'))
    const then = vi.spyOn(pending, 'then')
    const calls: Parameters<HttpFetcher>[] = []
    const fetcher: HttpFetcher = (...args) => {
      calls.push(args)
      return pending
    }
    const init = { headers: { Authorization: 'secret' }, signal: new AbortController().signal }
    setHttpFetcher(fetcher)
    expect(httpFetch('/private-path?token=secret', init)).toBe(pending)
    expect(calls).toEqual([['/private-path?token=secret', init]])
    expect(then).not.toHaveBeenCalled()
  })

  it('observes headers without consuming or replacing the response and drops all URL/header secrets', async () => {
    const events = observe()
    let finish!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => {
      finish = resolve
    })
    const fetcher = vi.fn<HttpFetcher>(() => pending)
    setHttpFetcher(fetcher)
    const init = { headers: { Authorization: 'private-key' } }
    const result = httpFetch(
      'https://user:password@example.test/private-track?token=hidden#fragment',
      init,
    )
    expect(result).toBe(pending)
    expect(fetcher.mock.calls[0]![1]).toBe(init)
    expect(events[0]).toMatchObject({ label: '其他资源', phase: 'pending', status: null })
    const response = new Response('private body')
    finish(response)
    expect(await result).toBe(response)
    expect(response.bodyUsed).toBe(false)
    expect(events.at(-1)).toMatchObject({ phase: 'completed', status: 200 })
    expect(JSON.stringify(events)).not.toMatch(
      /password|private-key|private-track|hidden|fragment|private body|example/,
    )
    expect(await response.text()).toBe('private body')
  })

  it('isolates throwing and mutation-attempting observers from the transport and other subscribers', async () => {
    detach.push(
      subscribeRuntimeHttp(() => {
        throw new Error('observer failed')
      }),
    )
    detach.push(
      subscribeRuntimeHttp((event) => {
        Reflect.set(event, 'label', 'mutated')
      }),
    )
    const events = observe()
    const response = new Response('ok')
    setHttpFetcher(async () => response)
    expect(await httpFetch('/api/lyrics?source=netease&id=secret')).toBe(response)
    expect(events.map((event) => event.phase)).toEqual(['pending', 'completed'])
    expect(events.every((event) => event.label === '网易云歌词')).toBe(true)
  })

  it('preserves rejection identity and distinguishes cancellation and HTTP errors', async () => {
    const events = observe()
    const error = new Error('private failure text')
    setHttpFetcher(() => Promise.reject(error))
    await expect(httpFetch('/failed')).rejects.toBe(error)
    expect(events.at(-1)?.phase).toBe('failed')
    const controller = new AbortController()
    controller.abort()
    await expect(httpFetch('/aborted', { signal: controller.signal })).rejects.toBe(error)
    expect(events.at(-1)?.phase).toBe('cancelled')
    const response = new Response('denied', { status: 403 })
    setHttpFetcher(async () => response)
    expect(await httpFetch('/denied')).toBe(response)
    expect(events.at(-1)).toMatchObject({ phase: 'failed', status: 403 })
    expect(JSON.stringify(events)).not.toContain('private failure')
  })

  it('preserves synchronous transport throws even when an observer throws', () => {
    const events = observe()
    detach.push(
      subscribeRuntimeHttp(() => {
        throw new Error('observer')
      }),
    )
    const error = new Error('transport')
    setHttpFetcher(() => {
      throw error
    })
    expect(() => httpFetch('/sync')).toThrow(error)
    expect(events.at(-1)?.phase).toBe('failed')
  })

  it('does not replay old in-flight completions after closing and reopening observation', async () => {
    const events: RuntimeHttpRequest[] = []
    const stop = subscribeRuntimeHttp((event) => events.push({ ...event }))
    let finish!: (response: Response) => void
    setHttpFetcher(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    const pending = httpFetch('/old')
    stop()
    const reopened = observe()
    finish(new Response('ok'))
    await pending
    expect(events.map((event) => event.phase)).toEqual(['pending'])
    expect(reopened).toEqual([])
  })

  it.each([
    ['/api/lyrics/qq?secret=1', 'QQ 歌词'],
    ['/api/lyrics?source=netease&id=2', '网易云歌词'],
    ['https://api.amll.dev/v1/lyrics/search?id=2', 'AMLL 歌词库'],
    ['https://cdn.jsdelivr.net/gh/amll-dev/amll-ttml-db@main/secret.ttml', 'AMLL 歌词库'],
    ['/meting?type=playlist&id=123', 'Meting 歌单'],
    ['/meting?type=lrc&id=123', 'Meting 歌词'],
    ['/meting?type=song&id=123', 'Meting 音频'],
    ['/meting?type=pic&id=123', 'Meting 封面'],
    ['/models/beat-this/small0-v1-00.bin', 'Beat This Small 模型'],
    ['/models/beat-this/final0-v1-00.bin', 'Beat This 标准模型'],
    ['/secret-session/private.json?token=foo#bar', '其他资源'],
  ])('labels known purpose without retaining the address (%s)', (url, label) => {
    expect(runtimeResourceLabel(url)).toBe(label)
  })
})
