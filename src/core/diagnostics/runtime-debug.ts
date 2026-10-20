export type RuntimeRequestPhase = 'pending' | 'completed' | 'failed' | 'cancelled'

/** Labels are fixed resource categories, never URLs, paths, headers or error text. */
export interface RuntimeHttpRequest {
  id: number
  label: string
  phase: RuntimeRequestPhase
  startedAtMs: number
  elapsedMs: number
  status: number | null
}

export interface RuntimeResourceEntry {
  id: number
  label: string
  initiator: string
  startTimeMs: number
  durationMs: number
  /** Null includes unavailable/opaque zero values; it does not imply a cache hit. */
  transferBytes: number | null
  decodedBytes: number | null
  responseStatus: number | null
}

export interface RuntimeDebugSnapshot {
  sampledAtMs: number
  observedSinceMs: number
  network: {
    online: boolean | null
    connectionType: string | null
    effectiveType: string | null
    rttMs: number | null
    downlinkMbps: number | null
    saveData: boolean | null
  }
  page: {
    visible: boolean
    width: number
    height: number
    dpr: number
    hardwareConcurrency: number | null
  }
  /** Legacy Chromium JS heap estimate; excludes separately allocated worker/GPU memory. */
  memory: { usedBytes: number; allocatedBytes: number; limitBytes: number } | null
  /** Peak of observed main-page JS heap samples during this visible session. */
  sampledHeapPeakBytes?: number | null
  audioCache: {
    pcmBytes: number
    encodedBytes: number
    pcmEntries: number
    encodedEntries: number
  } | null
  domElements: number | null
  fps: number | null
  longTasks: { count: number; totalMs: number; maxMs: number } | null
  storage: { usageBytes: number; quotaBytes: number } | null
  storageState: 'pending' | 'available' | 'unavailable'
  resourceTimingSupported: boolean
  resources: readonly RuntimeResourceEntry[]
  /** Only requests started while this observer was subscribed, up to 30 entries. */
  requests: readonly RuntimeHttpRequest[]
}

/** Deliberately discard even ordinary path names: they can contain private track IDs. */
export function runtimeResourceLabel(url: string): string {
  const path = url.split(/[?#]/, 1)[0]?.toLowerCase() ?? ''
  const query = url.split('?', 2)[1]?.split('#', 1)[0] ?? ''
  const lyrics = /\/api\/lyrics(?:\/|$)/.test(path)
  if (lyrics && (/\/netease(?:\/|$)/.test(path) || /(?:^|&)source=netease(?:&|$)/i.test(query)))
    return '网易云歌词'
  if (lyrics && (/\/qq(?:\/|$)/.test(path) || /(?:^|&)source=qq(?:&|$)/i.test(query)))
    return 'QQ 歌词'
  if (
    /^https:\/\/api\.amll\.dev\/v1\/lyrics(?:\/|$)/.test(path) ||
    /\/amll-dev\/amll-ttml-db(?:@|\/)/.test(path)
  )
    return 'AMLL 歌词库'
  if (/\/models\/beat-this\/small0-/.test(path)) return 'Beat This Small 模型'
  if (/\/models\/beat-this\/final0-/.test(path)) return 'Beat This 标准模型'
  if (/\/models\/beat-this\/runtime-/.test(path)) return '节拍推理运行时'
  if (/(?:^|&)type=playlist(?:&|$)/i.test(query)) return 'Meting 歌单'
  if (/(?:^|&)type=lrc(?:&|$)/i.test(query)) return 'Meting 歌词'
  if (/(?:^|&)type=song(?:&|$)/i.test(query)) return 'Meting 音频'
  if (/(?:^|&)type=pic(?:&|$)/i.test(query)) return 'Meting 封面'
  if (/\/models\//.test(path) || /\.(onnx|wasm|bin)$/.test(path)) return '模型资源'
  if (/\.(mp3|flac|wav|ogg|m4a|aac|opus)$/.test(path)) return '音频资源'
  if (/\.(png|jpe?g|webp|gif|svg|avif|ico)$/.test(path)) return '图片资源'
  if (/\.(m?js|ts)$/.test(path)) return '脚本资源'
  if (/\.css$/.test(path)) return '样式资源'
  if (/\.(woff2?|ttf|otf)$/.test(path)) return '字体资源'
  if (/\.(lrc|ttml|srt|vtt)$/.test(path)) return '歌词资源'
  if (/\/api(?:\/|$)/.test(path)) return '接口请求'
  return '其他资源'
}

// Transport and browser diagnostics meet at a platform-independent event port.
// No retained request log; removing a listener also invalidates old request tokens.
const httpObservers = new Map<number, (event: Readonly<RuntimeHttpRequest>) => void>()
let observerId = 0
let requestId = 0

export function subscribeRuntimeHttp(
  listener: (event: Readonly<RuntimeHttpRequest>) => void,
): () => void {
  const id = ++observerId
  httpObservers.set(id, listener)
  return () => {
    httpObservers.delete(id)
  }
}

export function hasRuntimeHttpObservers(): boolean {
  return httpObservers.size > 0
}

export function beginRuntimeHttp(
  label: string,
  startedAtMs: number,
): (phase: Exclude<RuntimeRequestPhase, 'pending'>, endedAtMs: number, status?: number) => void {
  const ids = [...httpObservers.keys()]
  const id = ++requestId
  const notify = (phase: RuntimeRequestPhase, endedAtMs: number, status?: number): void => {
    const event = Object.freeze({
      id,
      label,
      phase,
      startedAtMs,
      elapsedMs: Math.max(0, endedAtMs - startedAtMs),
      status: typeof status === 'number' && status > 0 ? status : null,
    })
    for (const listenerId of ids) {
      try {
        httpObservers.get(listenerId)?.(event)
      } catch {
        /* Diagnostics cannot affect I/O. */
      }
    }
  }
  notify('pending', startedAtMs)
  return notify
}
