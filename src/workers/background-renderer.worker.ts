interface BackgroundRequest {
  bitmap: ImageBitmap
  width: number
  height: number
  padding: number
  blur: number
  saturation: number
  scale: number
}

self.onmessage = (event: MessageEvent<BackgroundRequest>) => {
  const { bitmap, width, height, padding, blur, saturation, scale } = event.data
  const layers: ImageBitmap[] = []
  try {
    for (const bright of [false, true]) {
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      if (!context || !('filter' in context)) throw new Error('Canvas filters unavailable')
      context.filter = `blur(${Math.max(0, blur - (bright ? 8 : 0)) * scale}px) saturate(${saturation + (bright ? 0.3 : 0)}) brightness(${bright ? 1.8 : 1})`
      context.drawImage(bitmap, -padding, -padding)
      layers.push(canvas.transferToImageBitmap())
    }
    ;(self as unknown as Worker).postMessage({ layers }, layers)
  } catch {
    layers.forEach((layer) => layer.close())
    ;(self as unknown as Worker).postMessage({ layers: null })
  } finally {
    bitmap.close()
  }
}

export {}
