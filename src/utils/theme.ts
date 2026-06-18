import { LruCache } from './lru-cache'
import { extractThemeColorFromPixels, type ThemeColor } from './theme-core'

export type { ThemeColor } from './theme-core'
export { createThemeColor } from './theme-core'

const themeCache = new LruCache<string, ThemeColor | null>(64)
const SAMPLE_SIZE = 72
const WORKER_TIMEOUT_MS = 1500

// ===== Worker 单例（懒加载） =====
let workerInstance: Worker | null = null
let workerCreationFailed = false
let nextRequestId = 0
const pendingRequests = new Map<
  number,
  { resolve: (theme: ThemeColor | null) => void; timer: number }
>()

function supportsWorker(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap !== 'undefined'
  )
}

function getWorker(): Worker | null {
  if (workerCreationFailed) return null
  if (workerInstance) return workerInstance
  if (!supportsWorker()) return null
  try {
    workerInstance = new Worker(new URL('../workers/theme-extractor.worker.ts', import.meta.url), {
      type: 'module',
    })
    workerInstance.onmessage = (event: MessageEvent<{ id: number; theme: ThemeColor | null }>) => {
      const { id, theme } = event.data
      const pending = pendingRequests.get(id)
      if (!pending) return
      window.clearTimeout(pending.timer)
      pendingRequests.delete(id)
      pending.resolve(theme)
    }
    workerInstance.onerror = () => {
      // Worker 异常：把所有 pending 都 resolve 为 null（让上层走 fallback）
      for (const [, pending] of pendingRequests) {
        window.clearTimeout(pending.timer)
        pending.resolve(null)
      }
      pendingRequests.clear()
      workerInstance?.terminate()
      workerInstance = null
      workerCreationFailed = true
    }
    return workerInstance
  } catch {
    workerCreationFailed = true
    return null
  }
}

async function extractViaWorker(image: HTMLImageElement): Promise<ThemeColor | null> {
  const worker = getWorker()
  if (!worker) return null
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(image, {
      resizeWidth: SAMPLE_SIZE,
      resizeHeight: SAMPLE_SIZE,
      resizeQuality: 'low',
    })
  } catch {
    return null
  }
  const id = ++nextRequestId
  return new Promise<ThemeColor | null>((resolve) => {
    // 1.5s 超时兜底：Worker 卡住时回退到主线程
    const timer = window.setTimeout(() => {
      if (!pendingRequests.has(id)) return
      pendingRequests.delete(id)
      resolve(null)
    }, WORKER_TIMEOUT_MS)
    pendingRequests.set(id, { resolve, timer })
    try {
      worker.postMessage({ id, imageBitmap: bitmap }, [bitmap])
    } catch {
      window.clearTimeout(timer)
      pendingRequests.delete(id)
      bitmap.close?.()
      resolve(null)
    }
  })
}

function extractOnMainThread(image: HTMLImageElement): ThemeColor | null {
  const canvas = document.createElement('canvas')
  canvas.width = SAMPLE_SIZE
  canvas.height = SAMPLE_SIZE
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  try {
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
    const pixels = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data
    return extractThemeColorFromPixels(pixels, SAMPLE_SIZE, SAMPLE_SIZE)
  } catch {
    return null
  }
}

/**
 * 从 <img> 元素提取主题色。
 * - 支持 Worker 的浏览器：通过 Worker 处理（主线程仅 createImageBitmap + postMessage）
 * - 不支持时：主线程同步采样（与改造前行为一致）
 *
 * 返回 Promise 是因为新增了异步路径；上层 await 即可。
 */
export async function extractThemeColor(image: HTMLImageElement): Promise<ThemeColor | null> {
  if (supportsWorker()) {
    const theme = await extractViaWorker(image)
    if (theme) return theme
    // Worker 路径失败 / 超时 → 主线程兜底
  }
  return extractOnMainThread(image)
}

export function loadThemeColor(url: string): Promise<ThemeColor | null> {
  if (themeCache.has(url)) return Promise.resolve(themeCache.get(url) ?? null)
  return new Promise((resolve) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = async () => {
      const theme = await extractThemeColor(image)
      themeCache.set(url, theme)
      resolve(theme)
    }
    image.onerror = () => {
      themeCache.set(url, null)
      resolve(null)
    }
    image.src = url
  })
}
