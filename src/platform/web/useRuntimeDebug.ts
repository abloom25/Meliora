import { onBeforeUnmount, readonly, shallowRef, watch, type Ref } from 'vue'
import {
  runtimeResourceLabel,
  subscribeRuntimeHttp,
  type RuntimeDebugSnapshot,
  type RuntimeHttpRequest,
  type RuntimeResourceEntry,
} from '../../core/diagnostics/runtime-debug'

const SAMPLE_MS = 1000
const DOM_SAMPLE_MS = 10_000
const STORAGE_SAMPLE_MS = 30_000
const MAX_ENTRIES = 30

interface ConnectionInfo extends EventTarget {
  type?: string
  effectiveType?: string
  rtt?: number
  downlink?: number
  saveData?: boolean
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function memoryEstimate(): RuntimeDebugSnapshot['memory'] {
  const memory = (
    performance as Performance & {
      memory?: {
        usedJSHeapSize?: number
        totalJSHeapSize?: number
        jsHeapSizeLimit?: number
      }
    }
  ).memory
  const usedBytes = finite(memory?.usedJSHeapSize)
  const allocatedBytes = finite(memory?.totalJSHeapSize)
  const limitBytes = finite(memory?.jsHeapSizeLimit)
  return usedBytes !== null && allocatedBytes !== null && limitBytes !== null
    ? { usedBytes, allocatedBytes, limitBytes }
    : null
}

/** Observe only the currently visible diagnostic session; never replay past requests. */
export function useRuntimeDebug(
  enabled: Readonly<Ref<boolean>>,
  options: { readAudioCacheUsage?: () => RuntimeDebugSnapshot['audioCache'] } = {},
) {
  const snapshot = shallowRef<RuntimeDebugSnapshot | null>(null)
  let disposed = false
  let active = false
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let frame: number | null = null
  let frameCount = 0
  let frameWindowAt = 0
  let fps: number | null = null
  let sampledHeapPeakBytes: number | null = null
  let observedSinceMs = 0
  let domReadAt = -Infinity
  let storageReadAt = -Infinity
  let storagePending = false
  let domElements: number | null = null
  let audioCache: RuntimeDebugSnapshot['audioCache'] = null
  let storage: RuntimeDebugSnapshot['storage'] = null
  let storageState: RuntimeDebugSnapshot['storageState'] = 'unavailable'
  let resources: RuntimeResourceEntry[] = []
  let requests: RuntimeHttpRequest[] = []
  let longTasks: RuntimeDebugSnapshot['longTasks'] = null
  let resourceTimingSupported = false
  let resourceId = 0
  let observers: PerformanceObserver[] = []
  let unsubscribeHttp: (() => void) | null = null
  let connection: ConnectionInfo | undefined

  function publish(): void {
    if (!active || disposed || document.hidden || !enabled.value) return
    const now = performance.now()
    const memory = memoryEstimate()
    if (memory) sampledHeapPeakBytes = Math.max(sampledHeapPeakBytes ?? 0, memory.usedBytes)
    snapshot.value = {
      sampledAtMs: now,
      observedSinceMs,
      network: {
        online: typeof navigator.onLine === 'boolean' ? navigator.onLine : null,
        connectionType: [
          'bluetooth',
          'cellular',
          'ethernet',
          'none',
          'wifi',
          'wimax',
          'other',
          'unknown',
        ].includes(connection?.type ?? '')
          ? connection!.type!
          : null,
        effectiveType: ['slow-2g', '2g', '3g', '4g'].includes(connection?.effectiveType ?? '')
          ? connection!.effectiveType!
          : null,
        rttMs: finite(connection?.rtt),
        downlinkMbps: finite(connection?.downlink),
        saveData: typeof connection?.saveData === 'boolean' ? connection.saveData : null,
      },
      page: {
        visible: !document.hidden,
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio,
        hardwareConcurrency: finite(navigator.hardwareConcurrency),
      },
      memory,
      sampledHeapPeakBytes,
      audioCache: audioCache ? { ...audioCache } : null,
      domElements,
      fps,
      longTasks: longTasks ? { ...longTasks } : null,
      storage: storage ? { ...storage } : null,
      storageState,
      resourceTimingSupported,
      resources: resources.slice(),
      requests: requests.map((request) =>
        request.phase === 'pending'
          ? { ...request, elapsedMs: Math.max(0, now - request.startedAtMs) }
          : { ...request },
      ),
    }
  }

  function measureStorage(): void {
    storageReadAt = performance.now()
    if (!navigator.storage?.estimate || storagePending) return
    storagePending = true
    const ownGeneration = generation
    void Promise.resolve()
      .then(() => {
        if (!active || ownGeneration !== generation) return null
        return navigator.storage.estimate()
      })
      .then((estimate) => {
        if (!estimate || !active || ownGeneration !== generation) return
        const usageBytes = finite(estimate.usage)
        const quotaBytes = finite(estimate.quota)
        storage = usageBytes !== null && quotaBytes !== null ? { usageBytes, quotaBytes } : null
        storageState = storage ? 'available' : 'unavailable'
      })
      .catch(() => {
        if (ownGeneration === generation) storageState = 'unavailable'
      })
      .finally(() => {
        if (ownGeneration !== generation) return
        storagePending = false
        publish()
      })
  }

  function sample(): void {
    if (!active || disposed || document.hidden || !enabled.value) return
    const now = performance.now()
    try {
      audioCache = options.readAudioCacheUsage?.() ?? null
    } catch {
      audioCache = null
    }
    if (now - domReadAt >= DOM_SAMPLE_MS) {
      domElements = document.getElementsByTagName('*').length
      domReadAt = now
    }
    if (now - storageReadAt >= STORAGE_SAMPLE_MS) measureStorage()
    if (now - frameWindowAt >= SAMPLE_MS) {
      fps =
        typeof window.requestAnimationFrame === 'function'
          ? (frameCount * 1000) / (now - frameWindowAt)
          : null
      frameCount = 0
      frameWindowAt = now
    }
    publish()
    timer = setTimeout(sample, SAMPLE_MS)
  }

  function countFrame(): void {
    if (!active || disposed || document.hidden || !enabled.value) return
    frameCount += 1
    frame = window.requestAnimationFrame(countFrame)
  }

  function observe(type: 'resource' | 'longtask'): boolean {
    if (typeof PerformanceObserver !== 'function') return false
    if (
      PerformanceObserver.supportedEntryTypes &&
      !PerformanceObserver.supportedEntryTypes.includes(type)
    )
      return false
    let observer: PerformanceObserver | undefined
    const ownGeneration = generation
    try {
      observer = new PerformanceObserver((list) => {
        if (!active || disposed || ownGeneration !== generation) return
        for (const entry of list.getEntries()) {
          if (entry.startTime < observedSinceMs || !Number.isFinite(entry.duration)) continue
          if (type === 'longtask') {
            if (longTasks && entry.duration >= 50) {
              longTasks.count += 1
              longTasks.totalMs += entry.duration
              longTasks.maxMs = Math.max(longTasks.maxMs, entry.duration)
            }
            continue
          }
          const resource = entry as PerformanceResourceTiming
          const size = finite(resource.transferSize)
          const decoded = finite(resource.decodedBodySize)
          const status = finite(resource.responseStatus)
          resources.push({
            id: ++resourceId,
            label: runtimeResourceLabel(resource.name),
            initiator: [
              'audio',
              'video',
              'fetch',
              'xmlhttprequest',
              'img',
              'script',
              'link',
              'css',
              'other',
            ].includes(resource.initiatorType)
              ? resource.initiatorType
              : 'other',
            startTimeMs: resource.startTime,
            durationMs: Math.max(0, resource.duration),
            // Zero may be a cache hit, opaque cross-origin timing, or an empty body.
            // Keep it unknown rather than claiming a cache hit or no network traffic.
            transferBytes: size && size > 0 ? size : null,
            decodedBytes: decoded && decoded > 0 ? decoded : null,
            responseStatus: status && status > 0 ? status : null,
          })
          if (resources.length > MAX_ENTRIES) resources.shift()
        }
      })
      observer.observe({ type, buffered: false })
      observers.push(observer)
      return true
    } catch {
      observer?.disconnect()
      return false
    }
  }

  function stop(): void {
    active = false
    generation += 1
    if (timer !== null) clearTimeout(timer)
    if (frame !== null) window.cancelAnimationFrame(frame)
    timer = null
    frame = null
    for (const observer of observers) observer.disconnect()
    observers = []
    unsubscribeHttp?.()
    unsubscribeHttp = null
    window.removeEventListener('online', publish)
    window.removeEventListener('offline', publish)
    connection?.removeEventListener('change', publish)
    connection = undefined
    resources = []
    requests = []
    longTasks = null
    storage = null
    audioCache = null
    storagePending = false
    snapshot.value = null
  }

  function start(): void {
    if (disposed || !enabled.value || document.hidden || active) return
    active = true
    observedSinceMs = performance.now()
    frameWindowAt = observedSinceMs
    domReadAt = storageReadAt = -Infinity
    frameCount = 0
    fps = null
    sampledHeapPeakBytes = null
    domElements = null
    connection = (navigator as Navigator & { connection?: ConnectionInfo }).connection
    storageState = typeof navigator.storage?.estimate === 'function' ? 'pending' : 'unavailable'
    unsubscribeHttp = subscribeRuntimeHttp((event) => {
      if (!active) return
      if (event.phase === 'pending') {
        requests.push({ ...event })
        if (requests.length > MAX_ENTRIES) requests.shift()
      } else {
        const index = requests.findIndex((request) => request.id === event.id)
        if (index >= 0) requests[index] = { ...event }
      }
    })
    resourceTimingSupported = observe('resource')
    longTasks = observe('longtask') ? { count: 0, totalMs: 0, maxMs: 0 } : null
    window.addEventListener('online', publish)
    window.addEventListener('offline', publish)
    connection?.addEventListener('change', publish)
    if (typeof window.requestAnimationFrame === 'function')
      frame = window.requestAnimationFrame(countFrame)
    sample()
  }

  function visibilityChanged(): void {
    if (document.hidden) stop()
    else start()
  }

  watch(
    enabled,
    (value) => {
      stop()
      document.removeEventListener('visibilitychange', visibilityChanged)
      if (value) {
        document.addEventListener('visibilitychange', visibilityChanged)
        start()
      }
    },
    { flush: 'sync', immediate: true },
  )

  onBeforeUnmount(() => {
    disposed = true
    stop()
    document.removeEventListener('visibilitychange', visibilityChanged)
  })

  return { snapshot: readonly(snapshot) }
}
