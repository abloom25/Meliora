import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderBackground } from '../platform/web/artwork-background'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setup() {
  vi.stubGlobal('Worker', undefined)
  const drawImage = vi.fn()
  const context = { filter: 'none', drawImage }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  )
  const image = new Image()
  Object.defineProperties(image, {
    naturalWidth: { value: 1000 },
    naturalHeight: { value: 1000 },
  })
  const canvases: [HTMLCanvasElement, HTMLCanvasElement] = [
    document.createElement('canvas'),
    document.createElement('canvas'),
  ]
  return { image, canvases, drawImage }
}

const settings = { width: 1920, height: 1080, blur: 80, saturation: 1.2 }

describe('canvas artwork background', () => {
  it('limits both layers to 512 pixels while preserving aspect ratio', async () => {
    const { image, canvases } = setup()
    expect(await renderBackground(image, canvases, settings, new AbortController().signal)).toBe(
      true,
    )
    expect(canvases.map((canvas) => [canvas.width, canvas.height])).toEqual([
      [512, 288],
      [512, 288],
    ])
  })

  it('does not draw an aborted request', async () => {
    const { image, canvases, drawImage } = setup()
    const controller = new AbortController()
    controller.abort()
    expect(await renderBackground(image, canvases, settings, controller.signal)).toBe(false)
    expect(drawImage).not.toHaveBeenCalled()
  })

  it('keeps CSS fallback available when canvas filters are unsupported', async () => {
    const { image, canvases } = setup()
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    expect(await renderBackground(image, canvases, settings, new AbortController().signal)).toBe(
      false,
    )
  })

  it('cancels a pending worker without committing a stale result', async () => {
    const { image, canvases } = setup()
    const close = vi.fn()
    const terminate = vi.fn()
    let post!: () => void
    const posted = new Promise<void>((resolve) => {
      post = resolve
    })
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ close })),
    )
    vi.stubGlobal('OffscreenCanvas', class {})
    vi.stubGlobal(
      'Worker',
      class {
        postMessage = post
        terminate = terminate
      },
    )
    const controller = new AbortController()
    const pending = renderBackground(image, canvases, settings, controller.signal)
    await posted
    controller.abort()
    expect(await pending).toBe(false)
    expect(terminate).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(canvases[0].width).toBe(300)
  })
})
