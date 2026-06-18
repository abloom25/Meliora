/**
 * 主题色提取 Worker：在工作线程中处理 ImageBitmap 像素采样，避免阻塞主线程。
 *
 * 协议：
 *   主线程 → Worker:  { id: number, imageBitmap: ImageBitmap }
 *   Worker → 主线程:  { id: number, theme: ThemeColor | null }
 */

import { extractThemeColorFromPixels, type ThemeColor } from '../utils/theme-core'

interface RequestMessage {
  id: number
  imageBitmap: ImageBitmap
}

interface ResponseMessage {
  id: number
  theme: ThemeColor | null
}

// 复用 OffscreenCanvas 节省每次创建的开销
const SAMPLE_SIZE = 72
let canvas: OffscreenCanvas | null = null
let context: OffscreenCanvasRenderingContext2D | null = null

self.addEventListener('message', (event: MessageEvent<RequestMessage>) => {
  const { id, imageBitmap } = event.data
  let theme: ThemeColor | null = null
  try {
    if (!canvas) {
      canvas = new OffscreenCanvas(SAMPLE_SIZE, SAMPLE_SIZE)
      context = canvas.getContext('2d', { willReadFrequently: true })
    }
    if (context) {
      context.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
      context.drawImage(imageBitmap, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
      const pixels = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data
      theme = extractThemeColorFromPixels(pixels, SAMPLE_SIZE, SAMPLE_SIZE)
    }
  } catch {
    theme = null
  } finally {
    imageBitmap.close()
  }
  const response: ResponseMessage = { id, theme }
  ;(self as unknown as Worker).postMessage(response)
})
