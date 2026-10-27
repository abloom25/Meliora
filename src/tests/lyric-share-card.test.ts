import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLyricShareCardRenderer,
  renderLyricShareCard,
  type LyricShareCardInput,
} from '../platform/web/lyric-share-card'
import { shareCoverFallbackUrl } from '../../shared/share-cover'
import { flushPromises } from '@vue/test-utils'

const input: LyricShareCardInput = {
  track: { title: 'The song', artist: 'The artist', album: 'The album' },
  lines: [{ text: 'Somewhere in the light', translation: '在光芒中的某个地方' }],
  includeTranslation: true,
  timeLabel: '01:20–01:28',
}

function setupCanvas(): {
  context: CanvasRenderingContext2D
  fillText: ReturnType<typeof vi.fn>
  drawImage: ReturnType<typeof vi.fn>
  dimensions: Array<{ width: number; height: number }>
  canvas: () => HTMLCanvasElement | undefined
  blob: Blob
} {
  const fillText = vi.fn()
  const drawImage = vi.fn()
  const gradient = { addColorStop: vi.fn() }
  const context = {
    font: '',
    measureText: vi.fn((text: string) => {
      const size = Number(context.font.match(/(\d+)px/)?.[1] ?? 16)
      const segments = Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
      )
      const width = segments.reduce((total, { segment }) => {
        const ratio = /^\s+$/u.test(segment) ? 0.3 : /^[\x20-\x7e]+$/u.test(segment) ? 0.55 : 1
        return total + size * ratio
      }, 0)
      return {
        width,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
        actualBoundingBoxAscent: size * 0.85,
        actualBoundingBoxDescent: size * 0.2,
      }
    }),
    createLinearGradient: vi.fn(() => gradient),
    createRadialGradient: vi.fn(() => gradient),
    fillText,
    drawImage,
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    clip: vi.fn(),
  }
  const renderedCanvases: HTMLCanvasElement[] = []
  const dimensions: Array<{ width: number; height: number }> = []
  const blob = new Blob(['png'], { type: 'image/png' })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
  ) {
    renderedCanvases.push(this)
    dimensions.push({ width: this.width, height: this.height })
    callback(blob)
  })
  return {
    context: context as unknown as CanvasRenderingContext2D,
    fillText,
    drawImage,
    dimensions,
    canvas: () => renderedCanvases.at(-1),
    blob,
  }
}

function setupImage(): HTMLImageElement[] {
  const images: HTMLImageElement[] = []
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      crossOrigin: string | null = null
      decoding = 'auto'
      naturalWidth = 300
      naturalHeight = 400
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      decode = vi.fn(async () => {})
      removeAttribute = vi.fn((name: string) => {
        if (name === 'src') this.src = ''
      })
      constructor() {
        images.push(this as unknown as HTMLImageElement)
      }
    },
  )
  return images
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.documentElement.removeAttribute('style')
})

describe('lyric share card', () => {
  it('reuses decoded artwork and its blurred field across selections and releases both on close', async () => {
    const { drawImage, fillText } = setupCanvas()
    const images = setupImage()
    const renderer = createLyricShareCardRenderer()
    const withCover = { ...input, track: { ...input.track, cover: '/session-cover.png' } }
    const first = renderer.render(withCover)
    images[0]!.onload?.(new Event('load'))
    await first
    const firstDraws = drawImage.mock.calls.length
    const fields = drawImage.mock.calls
      .map(([image]) => image)
      .filter((image) => image instanceof HTMLCanvasElement) as HTMLCanvasElement[]
    expect(images[0]!.src).toBe('/session-cover.png')
    await renderer.render({ ...withCover, lines: [{ text: 'A different selection' }] })
    expect(images).toHaveLength(1)
    expect(images[0]!.decode).toHaveBeenCalledTimes(1)
    expect(drawImage.mock.calls.length - firstDraws).toBeLessThan(firstDraws)
    expect(fillText.mock.calls.map(([text]) => text)).toContain('A different selection')
    renderer.clear()
    expect(images[0]!.src).toBe('')
    expect(fields.every((canvas) => canvas.width === 1 && canvas.height === 1)).toBe(true)
  })

  it('does not retain artwork when aborted immediately after decoding', async () => {
    setupCanvas()
    const images = setupImage()
    const renderer = createLyricShareCardRenderer()
    const controller = new AbortController()
    const pending = renderer.render(
      { ...input, track: { ...input.track, cover: '/cancel-cover.png' } },
      controller.signal,
    )
    images[0]!.onload?.(new Event('load'))
    controller.abort()
    renderer.clear()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(images[0]!.src).toBe('')
  })

  it('releases late artwork after a session is cleared during loading', async () => {
    setupCanvas()
    const images = setupImage()
    const renderer = createLyricShareCardRenderer()
    const pending = renderer.render({
      ...input,
      track: { ...input.track, cover: '/late-session-cover.png' },
    })
    renderer.clear()
    images[0]!.onload?.(new Event('load'))
    await pending
    expect(images[0]!.src).toBe('')
  })

  it('keeps cached surfaces alive until a pending PNG encoder has finished', async () => {
    const { blob } = setupCanvas()
    const images = setupImage()
    const renderer = createLyricShareCardRenderer()
    const withCover = { ...input, track: { ...input.track, cover: '/encoding-session-cover.png' } }
    const first = renderer.render(withCover)
    images[0]!.onload?.(new Event('load'))
    await first
    let finish!: BlobCallback
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((callback) => {
      finish = callback
    })
    const pending = renderer.render(withCover)
    renderer.clear()
    expect(images[0]!.src).toBe('/encoding-session-cover.png')
    finish(blob)
    await pending
    expect(images[0]!.src).toBe('')
  })

  it('exports the complete selection and metadata at 1080 pixels then releases its canvas', async () => {
    const rendered = setupCanvas()
    const blob = await renderLyricShareCard(input)
    expect(blob).toBe(rendered.blob)
    expect(blob.type).toBe('image/png')
    expect(rendered.dimensions[0]!.width).toBe(1080)
    expect(rendered.dimensions[0]!.height).toBeGreaterThanOrEqual(640)
    expect(rendered.dimensions[0]!.height).toBeLessThan(900)
    const text = rendered.fillText.mock.calls.map(([value]) => value)
    expect(text).toEqual([
      'Somewhere in the light',
      '在光芒中的某个地方',
      'The song',
      'The artist',
      'Meliora',
      '01:20–01:28',
    ])
    expect(rendered.canvas()?.width).toBe(1)
    expect(rendered.canvas()?.height).toBe(1)
  })

  it('keeps a word intact when it fits on the next line and omits disabled translations', async () => {
    const { fillText } = setupCanvas()
    await renderLyricShareCard({
      ...input,
      lines: [{ text: 'abcdefghijklmnopqrstuv Babe', translation: '不会显示' }],
      includeTranslation: false,
    })
    const text = fillText.mock.calls.map(([value]) => value)
    expect(text).toContain('abcdefghijklmnopqrstuv')
    expect(text).toContain('Babe')
    expect(text).not.toContain('Bab')
    expect(text).not.toContain('不会显示')
  })

  it('wraps Chinese and emoji without losing characters or splitting a grapheme', async () => {
    const { fillText, dimensions } = setupCanvas()
    const lyric = '👨‍👩‍👧‍👦'.repeat(30) + '这是很长的一句歌词'.repeat(4)
    await renderLyricShareCard({
      track: { title: 'Title', artist: 'Artist' },
      lines: [{ text: lyric }],
      includeTranslation: false,
    })
    const text = fillText.mock.calls.map(([value]) => value as string)
    const rows = text.slice(0, -3)
    expect(rows.join('')).toBe(lyric)
    expect(rows.every((row) => !row.startsWith('\u200d') && !row.endsWith('\u200d'))).toBe(true)
    expect(dimensions[0]!.height).toBeGreaterThan(640)
    expect(dimensions[0]!.height).toBeLessThanOrEqual(4096)
  })

  it('grows for the full selection while keeping every baseline within the image', async () => {
    const { fillText, dimensions } = setupCanvas()
    await renderLyricShareCard({
      ...input,
      lines: Array.from({ length: 6 }, (_, index) => ({
        text: `A complete lyric line ${index} with words that need another row`,
        translation: `这是一句完整的翻译 ${index}`,
      })),
    })
    expect(dimensions[0]!.height).toBeGreaterThan(1200)
    expect(
      fillText.mock.calls.every(([, , baseline]) => baseline < dimensions[0]!.height - 60),
    ).toBe(true)
    for (let index = 0; index < 6; index++) {
      expect(fillText.mock.calls.some(([text]) => text === `这是一句完整的翻译 ${index}`)).toBe(
        true,
      )
    }
  })

  it('measures with the player fonts and keeps long song details below the excerpt', async () => {
    const { context, fillText, dimensions } = setupCanvas()
    document.documentElement.style.fontFamily = 'Player Body, sans-serif'
    const drawn: Array<{ text: string; font: string; x: number; y: number; width: number }> = []
    fillText.mockImplementation((text: string, x: number, y: number) => {
      drawn.push({ text, font: context.font, x, y, width: context.measureText(text).width })
    })
    const title = '很长的歌曲名称'.repeat(10)
    const artist = '很长的歌手名称'.repeat(6)
    await renderLyricShareCard({
      ...input,
      track: { title, artist },
      lines: [{ text: 'Babe' }],
    })
    expect(drawn.every((row) => row.font.includes('Player Body'))).toBe(true)
    expect(
      drawn
        .slice(1, -2)
        .map((row) => row.text)
        .join(''),
    ).toBe(title + artist)
    expect(drawn[1]!.y - drawn[0]!.y).toBeGreaterThan(80)
    expect(drawn.every((row) => row.x >= 88 && row.x + row.width <= 992)).toBe(true)
    expect(drawn.every((row) => row.y < dimensions[0]!.height - 60)).toBe(true)
  })

  it('rejects oversized content rather than truncating it', async () => {
    const { dimensions } = setupCanvas()
    await expect(
      renderLyricShareCard({ ...input, lines: [{ text: '很长'.repeat(2500) }] }),
    ).rejects.toThrow('请减少选中的歌词')
    expect(dimensions).toHaveLength(0)
    await expect(renderLyricShareCard({ ...input, lines: [] })).rejects.toThrow('1 到 6')
    await expect(
      renderLyricShareCard({
        ...input,
        lines: Array.from({ length: 7 }, () => ({ text: '歌词' })),
      }),
    ).rejects.toThrow('1 到 6')
  })

  it('loads an anonymous CORS cover, decodes it, and releases the resource after export', async () => {
    const { drawImage } = setupCanvas()
    const images = setupImage()
    const pending = renderLyricShareCard({
      ...input,
      track: { ...input.track, cover: 'https://cover.test/a.jpg' },
    })
    expect(images[0]!.crossOrigin).toBe('anonymous')
    images[0]!.onload?.(new Event('load'))
    await pending
    expect(images[0]!.decode).toHaveBeenCalledOnce()
    expect(drawImage).toHaveBeenCalledWith(images[0], 0, 50, 300, 300, 0, 0, 16, 16)
    expect(drawImage).toHaveBeenLastCalledWith(
      images[0],
      0,
      50,
      300,
      300,
      96,
      expect.any(Number),
      96,
      96,
    )
    const background = drawImage.mock.calls.find(
      ([source]) => source instanceof HTMLCanvasElement,
    )![0]
    expect(background.width).toBe(1)
    expect(background.height).toBe(1)
    expect(images[0]!.removeAttribute).toHaveBeenCalledWith('src')
    expect(images[0]!.onload).toBeNull()
    expect(images[0]!.onerror).toBeNull()
  })

  it('uses a successfully loaded cover even when its decode hint rejects', async () => {
    const { drawImage } = setupCanvas()
    const images = setupImage()
    const pending = renderLyricShareCard({
      ...input,
      track: { ...input.track, cover: '/decode-hint.jpg' },
    })
    vi.mocked(images[0]!.decode).mockRejectedValue(new Error('decode hint'))
    images[0]!.onload?.(new Event('load'))
    await pending
    expect(drawImage.mock.calls.filter(([source]) => source === images[0])).toHaveLength(2)
  })

  it('reports blocked artwork instead of silently exporting a coverless card', async () => {
    const { drawImage } = setupCanvas()
    const images = setupImage()
    const pending = renderLyricShareCard({
      ...input,
      track: { ...input.track, cover: 'https://cover.test/blocked.jpg' },
    })
    images[0]!.onerror?.(new Event('error'))
    await expect(pending).rejects.toThrow('封面暂时无法载入')
    expect(drawImage).not.toHaveBeenCalled()
    expect(images).toHaveLength(1)
    expect(images[0]!.crossOrigin).toBe('anonymous')
  })

  it('times out a stalled cover load and clears its handlers', async () => {
    vi.useFakeTimers()
    setupCanvas()
    const images = setupImage()
    const pending = renderLyricShareCard({
      ...input,
      track: { ...input.track, cover: '/stalled.jpg' },
    })
    const rejected = expect(pending).rejects.toThrow('封面暂时无法载入')
    await vi.advanceTimersByTimeAsync(8000)
    await rejected
    expect(images[0]!.src).toBe('')
    expect(images[0]!.onload).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels during image decode without drawing or waiting for its result', async () => {
    vi.useFakeTimers()
    const { drawImage } = setupCanvas()
    const images = setupImage()
    const controller = new AbortController()
    const pending = renderLyricShareCard(
      { ...input, track: { ...input.track, cover: '/cancelled.jpg' } },
      controller.signal,
    )
    vi.mocked(images[0]!.decode).mockReturnValue(new Promise<void>(() => {}))
    images[0]!.onload?.(new Event('load'))
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(drawImage).not.toHaveBeenCalled()
    expect(images[0]!.src).toBe('')
    expect(vi.getTimerCount()).toBe(0)
    const retry = renderLyricShareCard({
      ...input,
      track: { ...input.track, cover: '/cancelled.jpg' },
    })
    expect(images).toHaveLength(2)
    images[1]!.onload?.(new Event('load'))
    await retry
  })

  it.each(['load', 'tainted'])(
    'uses a same-origin cover after a direct %s failure, retaining both thumbnail and blur',
    async (failure) => {
      const { blob, drawImage } = setupCanvas()
      if (failure === 'tainted') {
        vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce(() => {
          throw new DOMException('Tainted canvas', 'SecurityError')
        })
      }
      const images = setupImage()
      const cover = `https://y.gtimg.cn/music/photo_new/${failure}.jpg`
      const pending = renderLyricShareCard({
        ...input,
        track: { ...input.track, cover },
      })
      if (failure === 'tainted') images[0]!.onload?.(new Event('load'))
      else images[0]!.onerror?.(new Event('error'))
      await flushPromises()
      expect(images).toHaveLength(2)
      expect(images[1]!.src).toBe(shareCoverFallbackUrl(cover, true))
      expect(images[1]!.crossOrigin).toBe('anonymous')
      images[1]!.onload?.(new Event('load'))
      expect(await pending).toBe(blob)
      expect(drawImage.mock.calls.filter(([source]) => source === images[1])).toHaveLength(2)
      expect(images.every((image) => image.src === '')).toBe(true)
    },
  )

  it('skips a recently failed cover during reselection and retries after its short TTL', async () => {
    vi.useFakeTimers()
    const { blob } = setupCanvas()
    const images = setupImage()
    const selection = {
      ...input,
      track: { ...input.track, cover: '/failed-retry.jpg' },
    }
    const initial = renderLyricShareCard(selection)
    images[0]!.onerror?.(new Event('error'))
    await expect(initial).rejects.toThrow('封面暂时无法载入')
    await expect(renderLyricShareCard({ ...selection, includeTranslation: false })).rejects.toThrow(
      '封面暂时无法载入',
    )
    expect(images).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30_000)
    const retry = renderLyricShareCard(selection)
    expect(images).toHaveLength(2)
    images[1]!.onload?.(new Event('load'))
    expect(await retry).toBe(blob)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets manual retry bypass both failed cover candidates immediately', async () => {
    const { blob } = setupCanvas()
    const images = setupImage()
    const selection = {
      ...input,
      track: { ...input.track, cover: 'https://y.gtimg.cn/music/photo_new/manual.jpg' },
    }
    const pending = renderLyricShareCard(selection)
    const failed = expect(pending).rejects.toThrow('封面暂时无法载入')
    images[0]!.onerror?.(new Event('error'))
    await flushPromises()
    images[1]!.onerror?.(new Event('error'))
    await failed
    const retry = renderLyricShareCard(selection, undefined, { retryCover: true })
    expect(images).toHaveLength(3)
    images[2]!.onerror?.(new Event('error'))
    await flushPromises()
    expect(images).toHaveLength(4)
    images[3]!.onload?.(new Event('load'))
    expect(await retry).toBe(blob)
  })

  it('uses a permitted direct cover without contacting the relay or treating encoder failure as a cover failure', async () => {
    const { blob } = setupCanvas()
    const images = setupImage()
    const selection = {
      ...input,
      track: { ...input.track, cover: 'https://y.gtimg.cn/music/photo_new/direct.jpg' },
    }
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce((callback) =>
      callback(null),
    )
    const pending = renderLyricShareCard(selection)
    images[0]!.onload?.(new Event('load'))
    await expect(pending).rejects.toThrow('图片生成失败')
    expect(images).toHaveLength(1)
    const retry = renderLyricShareCard(selection)
    expect(images[1]!.src).toBe(selection.track.cover)
    images[1]!.onload?.(new Event('load'))
    expect(await retry).toBe(blob)
    expect(images).toHaveLength(2)
  })

  it('cancels a pending PNG encoder and ignores its late callback', async () => {
    vi.useFakeTimers()
    setupCanvas()
    let callback: BlobCallback | undefined
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((encoded) => {
      callback = encoded
    })
    const controller = new AbortController()
    const pending = renderLyricShareCard(input, controller.signal)
    await Promise.resolve()
    expect(callback).toBeDefined()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    callback?.(new Blob(['late'], { type: 'image/png' }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports encoder failure in Chinese and never starts work for an aborted request', async () => {
    const { fillText } = setupCanvas()
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((callback) => callback(null))
    await expect(renderLyricShareCard(input)).rejects.toThrow('图片生成失败')
    fillText.mockClear()
    const controller = new AbortController()
    controller.abort()
    await expect(renderLyricShareCard(input, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fillText).not.toHaveBeenCalled()
  })
})
