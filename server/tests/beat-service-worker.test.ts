import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

async function dispatchFetch(options: {
  cached?: Response
  network: Promise<Response>
  cacheWrite?: () => Promise<void>
  navigate?: boolean
  url?: string
  accept?: string
  range?: string
  destination?: string
}) {
  let handler!: (event: unknown) => void
  let response!: Promise<Response>
  const work: Promise<unknown>[] = []
  const put = vi.fn(options.cacheWrite ?? (() => Promise.resolve()))
  void options.network.catch(() => {})
  const source = await readFile(join(process.cwd(), 'public/sw.js'), 'utf8')
  runInNewContext(source, {
    self: {
      location: { origin: 'https://example.com' },
      addEventListener(name: string, callback: typeof handler) {
        if (name === 'fetch') handler = callback
      },
    },
    caches: { match: () => Promise.resolve(options.cached), open: () => Promise.resolve({ put }) },
    fetch: () => options.network,
    URL,
    Response,
  })
  handler({
    request: {
      headers: new Headers({
        ...(options.accept ? { accept: options.accept } : {}),
        ...(options.range ? { range: options.range } : {}),
      }),
      method: 'GET',
      url: options.url ?? 'https://example.com/assets/app.js',
      destination: options.destination ?? 'script',
      mode: options.navigate ? 'navigate' : 'cors',
    },
    respondWith(value: Promise<Response>) {
      response = value
    },
    waitUntil(value: Promise<unknown>) {
      work.push(value)
    },
  })
  return { response, work, put }
}

describe('service worker analysis resource ownership', () => {
  it('leaves complete-song analysis fetches outside app-shell caching', async () => {
    const event = await dispatchFetch({
      url: 'https://example.com/recordings/song.mp3',
      accept: 'audio/*',
      destination: '',
      network: Promise.resolve(new Response('audio')),
    })
    expect(event.response).toBeUndefined()
    expect(event.work).toHaveLength(0)
    expect(event.put).not.toHaveBeenCalled()
  })

  it('keeps Range requests outside the shell cache regardless of destination', async () => {
    const event = await dispatchFetch({
      url: 'https://example.com/recordings/song.mp3',
      range: 'bytes=100-200',
      destination: '',
      network: Promise.resolve(new Response('audio', { status: 206 })),
    })
    expect(event.response).toBeUndefined()
    expect(event.work).toHaveLength(0)
    expect(event.put).not.toHaveBeenCalled()
  })

  it('leaves optional models to the explicit download cache without background refetching', async () => {
    const event = await dispatchFetch({
      url: 'https://example.com/models/beat-this/small0-v1-00.bin',
      cached: new Response('model'),
      network: Promise.resolve(new Response('fresh')),
    })
    expect(event.response).toBeUndefined()
    expect(event.work).toHaveLength(0)
    expect(event.put).not.toHaveBeenCalled()
  })
})
