import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { useRuntimeDebug } from '../platform/web/useRuntimeDebug'
import { hasRuntimeHttpObservers } from '../core/diagnostics/runtime-debug'
import { httpFetch, setHttpFetcher } from '../services/http'

class ObserverMock {
  static supportedEntryTypes = ['resource', 'longtask']
  static instances: ObserverMock[] = []
  readonly callback: PerformanceObserverCallback
  type = ''
  observe = vi.fn((options: PerformanceObserverInit) => {
    this.type = options.type ?? ''
  })
  disconnect = vi.fn()
  constructor(callback: PerformanceObserverCallback) {
    this.callback = callback
    ObserverMock.instances.push(this)
  }
  emit(entries: PerformanceEntry[]): void {
    this.callback(
      { getEntries: () => entries } as PerformanceObserverEntryList,
      this as unknown as PerformanceObserver,
    )
  }
}

const wrappers: VueWrapper[] = []
let hidden = false
let frameId = 0
const frames = new Map<number, FrameRequestCallback>()
let estimate: ReturnType<typeof vi.fn<() => Promise<StorageEstimate>>>

function harness(
  initiallyEnabled = false,
  readAudioCacheUsage?: Parameters<typeof useRuntimeDebug>[1],
) {
  const enabled = ref(initiallyEnabled)
  let diagnostics!: ReturnType<typeof useRuntimeDebug>
  const wrapper = mount(
    defineComponent({
      setup() {
        diagnostics = useRuntimeDebug(enabled, readAudioCacheUsage)
        return () => h('div')
      },
    }),
  )
  wrappers.push(wrapper)
  return { enabled, diagnostics, wrapper }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
}

function resource(overrides: Partial<PerformanceResourceTiming> = {}): PerformanceResourceTiming {
  return {
    name: 'https://user:password@example.test/private/path?key=secret#token',
    startTime: performance.now(),
    duration: 120,
    entryType: 'resource',
    initiatorType: 'fetch',
    transferSize: 0,
    decodedBodySize: 0,
    responseStatus: 0,
    ...overrides,
  } as PerformanceResourceTiming
}

beforeEach(() => {
  vi.useFakeTimers()
  hidden = false
  frameId = 0
  frames.clear()
  ObserverMock.instances = []
  ObserverMock.supportedEntryTypes = ['resource', 'longtask']
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  vi.stubGlobal('PerformanceObserver', ObserverMock)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = ++frameId
    frames.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id)
  })
  estimate = vi.fn(async () => ({ usage: 1024, quota: 4096 }))
  vi.stubGlobal('navigator', {
    onLine: true,
    hardwareConcurrency: 8,
    storage: { estimate },
    connection: Object.assign(new EventTarget(), {
      type: 'wifi',
      effectiveType: '4g',
      rtt: 80,
      downlink: 12.5,
      saveData: false,
    }),
  })
})

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  setHttpFetcher(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('runtime diagnostics lifecycle and sampling', () => {
  it('retains only the current visible session heap sample peak and resets when reopened', async () => {
    const memory = { usedJSHeapSize: 100, totalJSHeapSize: 500, jsHeapSizeLimit: 1000 }
    const now = performance.now.bind(performance)
    vi.stubGlobal('performance', { now, memory })
    const { enabled, diagnostics } = harness(true)
    await settle()
    expect(diagnostics.snapshot.value?.sampledHeapPeakBytes).toBe(100)
    memory.usedJSHeapSize = 300
    vi.advanceTimersByTime(1000)
    memory.usedJSHeapSize = 120
    vi.advanceTimersByTime(1000)
    expect(diagnostics.snapshot.value?.memory?.usedBytes).toBe(120)
    expect(diagnostics.snapshot.value?.sampledHeapPeakBytes).toBe(300)
    enabled.value = false
    enabled.value = true
    await settle()
    expect(diagnostics.snapshot.value?.sampledHeapPeakBytes).toBe(120)
  })

  it('does no collection while closed and removes all observers, timers and frames on close', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { enabled, diagnostics } = harness()
    // Vue's first mount schedules a 3s devtools-hook discovery timeout.
    vi.advanceTimersByTime(3000)
    expect(diagnostics.snapshot.value).toBeNull()
    expect(ObserverMock.instances).toHaveLength(0)
    expect(hasRuntimeHttpObservers()).toBe(false)
    expect(frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(estimate).not.toHaveBeenCalled()
    enabled.value = true
    await settle()
    expect(ObserverMock.instances).toHaveLength(2)
    expect(hasRuntimeHttpObservers()).toBe(true)
    expect(frames.size).toBe(1)
    expect(diagnostics.snapshot.value?.network).toMatchObject({
      online: true,
      connectionType: 'wifi',
      rttMs: 80,
      downlinkMbps: 12.5,
    })
    expect(fetch).not.toHaveBeenCalled()
    enabled.value = false
    expect(diagnostics.snapshot.value).toBeNull()
    expect(
      ObserverMock.instances.every((observer) => observer.disconnect.mock.calls.length === 1),
    ).toBe(true)
    expect(hasRuntimeHttpObservers()).toBe(false)
    expect(frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(estimate).toHaveBeenCalledTimes(1)
  })

  it('stops when hidden and rejects previous-generation callbacks and storage replies', async () => {
    let resolve!: (value: StorageEstimate) => void
    estimate.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const { diagnostics } = harness(true)
    await settle()
    const staleObserver = ObserverMock.instances[0]!
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(diagnostics.snapshot.value).toBeNull()
    expect(frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    staleObserver.emit([resource()])
    resolve({ usage: 999999, quota: 999999 })
    await settle()
    vi.advanceTimersByTime(1000)
    expect(diagnostics.snapshot.value?.resources).toEqual([])
    expect(diagnostics.snapshot.value?.storage).toEqual({ usageBytes: 1024, quotaBytes: 4096 })
  })

  it('does not start a deferred storage read after immediate close and handles missing capabilities', async () => {
    ObserverMock.supportedEntryTypes = []
    const { enabled, diagnostics } = harness(true)
    expect(diagnostics.snapshot.value?.resourceTimingSupported).toBe(false)
    expect(diagnostics.snapshot.value?.longTasks).toBeNull()
    expect(diagnostics.snapshot.value?.memory).toBeNull()
    expect(diagnostics.snapshot.value?.fps).toBeNull()
    enabled.value = false
    await settle()
    expect(estimate).not.toHaveBeenCalled()
  })

  it('bounds and redacts resource entries and does not mistake opaque zero sizes for cache hits', () => {
    const { diagnostics } = harness(true)
    const observer = ObserverMock.instances.find((entry) => entry.type === 'resource')!
    expect(observer.observe).toHaveBeenCalledWith({ type: 'resource', buffered: false })
    observer.emit([
      resource({ startTime: -100 }),
      ...Array.from({ length: 40 }, (_, index) => resource({ duration: index + 1 })),
    ])
    vi.advanceTimersByTime(1000)
    const snapshot = diagnostics.snapshot.value!
    expect(snapshot.resources).toHaveLength(30)
    expect(snapshot.resources[0]?.durationMs).toBe(11)
    expect(snapshot.resources[0]).toMatchObject({
      transferBytes: null,
      decodedBytes: null,
      responseStatus: null,
      label: '其他资源',
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/password|example\.test|private|secret|token/)
    observer.emit([
      resource({
        name: '/models/beat-this/small0-v1-00.bin',
        transferSize: 1000,
        decodedBodySize: 900,
        responseStatus: 200,
      }),
    ])
    vi.advanceTimersByTime(1000)
    expect(diagnostics.snapshot.value?.resources.at(-1)).toMatchObject({
      label: 'Beat This Small 模型',
      transferBytes: 1000,
      decodedBytes: 900,
      responseStatus: 200,
    })
  })

  it('records only HTTP requests started during this visible observation session', async () => {
    let finish!: (response: Response) => void
    setHttpFetcher(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const before = httpFetch('/before-panel')
    const { enabled, diagnostics } = harness(true)
    finish(new Response('old'))
    await before
    vi.advanceTimersByTime(1000)
    expect(diagnostics.snapshot.value?.requests).toEqual([])
    const pending = httpFetch('/api/lyrics?source=qq&id=secret')
    vi.advanceTimersByTime(1000)
    expect(diagnostics.snapshot.value?.requests[0]).toMatchObject({
      phase: 'pending',
      label: 'QQ 歌词',
      elapsedMs: 1000,
    })
    enabled.value = false
    enabled.value = true
    finish(new Response('late'))
    await pending
    vi.advanceTimersByTime(1000)
    expect(diagnostics.snapshot.value?.requests).toEqual([])
  })

  it('bounds request history while retaining the original HTTP response', async () => {
    const { diagnostics } = harness(true)
    setHttpFetcher(async () => new Response('ok'))
    for (let index = 0; index < 40; index++) {
      const response = await httpFetch(`/track-${index}.mp3?secret=yes`)
      expect(await response.text()).toBe('ok')
    }
    vi.advanceTimersByTime(1000)
    expect(diagnostics.snapshot.value?.requests).toHaveLength(30)
    expect(
      diagnostics.snapshot.value?.requests.every((request) => request.phase === 'completed'),
    ).toBe(true)
  })

  it('samples DOM and storage at their lower frequencies and measures real animation-frame counts', async () => {
    const dom = vi.spyOn(document, 'getElementsByTagName')
    const usage = { pcmBytes: 400, encodedBytes: 80, pcmEntries: 2, encodedEntries: 1 }
    const readAudioCacheUsage = vi.fn(() => usage)
    const { diagnostics } = harness(true, { readAudioCacheUsage })
    await settle()
    dom.mockClear()
    for (let index = 0; index < 50; index++) {
      vi.advanceTimersByTime(20)
      const callbacks = [...frames.values()]
      frames.clear()
      callbacks.forEach((callback) => callback(performance.now()))
    }
    expect(diagnostics.snapshot.value?.fps).toBe(49)
    expect(diagnostics.snapshot.value?.audioCache).toEqual(usage)
    const longTask = ObserverMock.instances.find((entry) => entry.type === 'longtask')!
    longTask.emit([
      resource({ entryType: 'longtask', duration: 75 }),
      resource({ entryType: 'longtask', duration: 120 }),
    ])
    vi.advanceTimersByTime(8000)
    await settle()
    expect(dom).not.toHaveBeenCalled()
    expect(estimate).toHaveBeenCalledTimes(1)
    expect(diagnostics.snapshot.value?.longTasks).toEqual({ count: 2, totalMs: 195, maxMs: 120 })
    vi.advanceTimersByTime(1000)
    expect(dom).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(20_000)
    await settle()
    expect(estimate).toHaveBeenCalledTimes(2)
    expect(dom).toHaveBeenCalledTimes(3)
  })

  it('fails optional observers and storage estimates softly and releases resources on unmount', async () => {
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        static supportedEntryTypes = ['resource', 'longtask']
        observe() {
          throw new Error('unsupported')
        }
        disconnect() {}
      },
    )
    estimate.mockRejectedValue(new Error('denied'))
    const readAudioCacheUsage = vi.fn(() => {
      throw new Error('optional')
    })
    const { diagnostics, wrapper } = harness(true, { readAudioCacheUsage })
    await settle()
    expect(diagnostics.snapshot.value).toMatchObject({
      resourceTimingSupported: false,
      storageState: 'unavailable',
      storage: null,
      audioCache: null,
    })
    wrapper.unmount()
    expect(diagnostics.snapshot.value).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expect(frames.size).toBe(0)
    expect(hasRuntimeHttpObservers()).toBe(false)
  })
})
