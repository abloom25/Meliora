export interface BackgroundSettings {
  width: number
  height: number
  blur: number
  saturation: number
}

/** Display-only images may be cross-origin: no readback or export is needed. */
export function loadBackgroundImage(
  url: string,
  signal: AbortSignal,
): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image()
    let settled = false
    let retry = false
    const finish = (result: HTMLImageElement | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      image.onload = image.onerror = null
      if (!result) image.removeAttribute('src')
      resolve(result)
    }
    const abort = () => finish(null)
    const timer = setTimeout(abort, 8000)
    signal.addEventListener('abort', abort, { once: true })
    image.onload = () => {
      // decode is only a readiness hint; a loaded image remains drawable if it rejects.
      void image
        .decode()
        .catch(() => {})
        .then(() => finish(signal.aborted ? null : image))
    }
    image.onerror = () => {
      if (retry) return finish(null)
      retry = true
      image.removeAttribute('crossorigin')
      image.src = url
    }
    image.crossOrigin = 'anonymous'
    if (signal.aborted) abort()
    else image.src = url
  })
}

/** Bounded backing store, independent of DPR. Blur hides the reduced sampling resolution. */
export async function renderBackground(
  image: HTMLImageElement,
  canvases: readonly [HTMLCanvasElement, HTMLCanvasElement],
  settings: BackgroundSettings,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || !image.naturalWidth || !image.naturalHeight) return false
  const scale = Math.min(1, 512 / Math.max(settings.width, settings.height))
  const width = Math.max(1, Math.round(settings.width * scale))
  const height = Math.max(1, Math.round(settings.height * scale))
  const padding = Math.ceil(settings.blur * scale * 3)
  const source = document.createElement('canvas')
  source.width = width + padding * 2
  source.height = height + padding * 2
  const context = source.getContext('2d')
  if (!context) return false
  const ratio = Math.max(width / image.naturalWidth, height / image.naturalHeight)
  const dw = image.naturalWidth * ratio
  const dh = image.naturalHeight * ratio
  const x = padding + (width - dw) / 2
  const y = padding + (height - dh) / 2
  context.drawImage(image, x, y, dw, dh)
  // Extend edge pixels into the blur margin instead of fading into transparent black.
  for (const [sx, sy, sw, sh, dx, dy, tw, th] of [
    [padding, padding, width, 1, padding, 0, width, padding],
    [padding, padding + height - 1, width, 1, padding, padding + height, width, padding],
  ])
    context.drawImage(source, sx!, sy!, sw!, sh!, dx!, dy!, tw!, th!)
  context.drawImage(source, padding, 0, 1, source.height, 0, 0, padding, source.height)
  context.drawImage(
    source,
    padding + width - 1,
    0,
    1,
    source.height,
    padding + width,
    0,
    padding,
    source.height,
  )

  const commit = (layers: readonly CanvasImageSource[]): boolean => {
    if (signal.aborted) return false
    return canvases.every((canvas, index) => {
      canvas.width = width
      canvas.height = height
      const target = canvas.getContext('2d')
      if (!target) return false
      target.drawImage(layers[index]!, 0, 0)
      return true
    })
  }

  if (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap !== 'undefined'
  ) {
    let bitmap: ImageBitmap | null = null
    let worker: Worker | null = null
    try {
      bitmap = await createImageBitmap(source)
      if (signal.aborted) return false
      worker = new Worker(new URL('../../workers/background-renderer.worker.ts', import.meta.url), {
        type: 'module',
      })
      const activeWorker = worker
      const layers = await new Promise<ImageBitmap[] | null>((resolve) => {
        let settled = false
        const finish = (result: ImageBitmap[] | null) => {
          if (settled) {
            result?.forEach((layer) => layer.close())
            return
          }
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          resolve(result)
        }
        const abort = () => finish(null)
        const timer = setTimeout(abort, 1500)
        signal.addEventListener('abort', abort, { once: true })
        activeWorker.onmessage = (event: MessageEvent<{ layers: ImageBitmap[] | null }>) =>
          finish(event.data.layers)
        activeWorker.onerror = activeWorker.onmessageerror = () => finish(null)
        try {
          activeWorker.postMessage(
            {
              bitmap,
              width,
              height,
              padding,
              blur: settings.blur,
              saturation: settings.saturation,
              scale,
            },
            [bitmap!],
          )
        } catch {
          finish(null)
        }
      })
      if (layers) {
        try {
          return commit(layers)
        } finally {
          layers.forEach((layer) => layer.close())
        }
      }
    } catch {
      // Tainted images cannot transfer; the bounded main-thread path can still display them.
    } finally {
      worker?.terminate()
      bitmap?.close()
    }
  }
  if (signal.aborted) return false
  const layers = [false, true].map((bright) => {
    const layer = document.createElement('canvas')
    layer.width = width
    layer.height = height
    const target = layer.getContext('2d')
    if (!target || !('filter' in target)) return null
    target.filter = `blur(${Math.max(0, settings.blur - (bright ? 8 : 0)) * scale}px) saturate(${settings.saturation + (bright ? 0.3 : 0)}) brightness(${bright ? 1.8 : 1})`
    target.drawImage(source, -padding, -padding)
    return layer
  })
  return layers.every((layer) => layer !== null) && commit(layers as HTMLCanvasElement[])
}
