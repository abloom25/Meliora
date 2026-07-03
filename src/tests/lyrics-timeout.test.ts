import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadLyricsText } from '../services/lyrics'

describe('loadLyricsText timeout', () => {
  afterEach(() => {
    // 还原所有 mock 与定时器，避免污染其它用例
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('rejects after 8 seconds when fetch never resolves', async () => {
    vi.useFakeTimers()

    // 让 fetch 永不 resolve，仅在 signal 被中止时拒绝（贴近真实浏览器行为）
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          if (signal.aborted) {
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
            return
          }
          signal.addEventListener('abort', () => {
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          })
        }
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const promise = loadLyricsText('https://example.test/lyric.lrc')
    // 兜底防止 unhandledRejection 干扰断言
    promise.catch(() => {})

    // 推进到 8000ms，触发本地 controller.abort()
    await vi.advanceTimersByTimeAsync(8000)

    await expect(promise).rejects.toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('lets an aborted cache-hit caller reject without aborting the shared lyrics request', async () => {
    let resolveFetch!: (response: Response) => void
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        resolveFetch = resolve
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const first = loadLyricsText('https://example.test/cache-hit-abort.lrc')
    const controller = new AbortController()
    const second = loadLyricsText('https://example.test/cache-hit-abort.lrc', controller.signal)
    second.catch(() => {})

    controller.abort(new DOMException('Caller aborted', 'AbortError'))

    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    resolveFetch(new Response('cached lyric'))
    await expect(first).resolves.toBe('cached lyric')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('lets the first caller abort without cancelling the shared lyrics request', async () => {
    let resolveFetch!: (response: Response) => void
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        resolveFetch = resolve
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    const first = loadLyricsText('https://example.test/first-caller-abort.lrc', controller.signal)
    const second = loadLyricsText('https://example.test/first-caller-abort.lrc')
    first.catch(() => {})

    controller.abort(new DOMException('Caller aborted', 'AbortError'))

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    resolveFetch(new Response('shared lyric'))
    await expect(second).resolves.toBe('shared lyric')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects immediately when a cache hit is called with an already aborted signal', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('ready lyric')))
    vi.stubGlobal('fetch', fetchMock)

    await expect(loadLyricsText('https://example.test/ready-cache.lrc')).resolves.toBe(
      'ready lyric',
    )
    const controller = new AbortController()
    controller.abort(new DOMException('Already aborted', 'AbortError'))

    await expect(
      loadLyricsText('https://example.test/ready-cache.lrc', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
