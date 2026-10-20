import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchLyricsJson, readLyricsBytes } from '../core/lyrics/upstream'

describe('bounded native lyrics transport', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('parses JSON and refuses redirects at the transport boundary', async () => {
    const fetcher = vi.fn(async () => Response.json({ code: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(
      await fetchLyricsJson('https://music.example/lyrics', { method: 'POST' }, signal),
    ).toEqual({
      code: 200,
    })
    expect(fetcher).toHaveBeenCalledWith('https://music.example/lyrics', {
      method: 'POST',
      signal,
      redirect: 'manual',
    })
  })

  it('rejects a redirect without following it', async () => {
    const cancelled = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel: cancelled }), {
            status: 302,
            headers: { Location: 'https://other.example/lyrics' },
          }),
      ),
    )
    await expect(
      fetchLyricsJson('https://music.example', {}, new AbortController().signal),
    ).rejects.toThrow('302')
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('rejects upstream errors and malformed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 429 })),
    )
    await expect(
      fetchLyricsJson('https://music.example', {}, new AbortController().signal),
    ).rejects.toThrow('429')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>error</html>')),
    )
    await expect(
      fetchLyricsJson('https://music.example', {}, new AbortController().signal),
    ).rejects.toThrow()
  })

  it('enforces byte limits with and without declared lengths', async () => {
    const signal = new AbortController().signal
    await expect(
      readLyricsBytes(new Response('small', { headers: { 'Content-Length': '100' } }), signal, 8),
    ).rejects.toThrow('too large')
    const cancelled = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20))
      },
      cancel: cancelled,
    })
    await expect(readLyricsBytes(new Response(body), signal, 8)).rejects.toThrow('too large')
    expect(cancelled).toHaveBeenCalled()
  })

  it('aborts even if fetch itself ignores cancellation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
    const controller = new AbortController()
    const pending = fetchLyricsJson('https://music.example', {}, controller.signal)
    controller.abort(new Error('cancelled lookup'))
    await expect(pending).rejects.toThrow('cancelled lookup')
  })

  it('cancels a stalled body reader when its request is aborted', async () => {
    const cancel = vi.fn()
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const pending = readLyricsBytes(new Response(body), controller.signal)
    controller.abort(new Error('cancelled body'))
    await expect(pending).rejects.toThrow('cancelled body')
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
