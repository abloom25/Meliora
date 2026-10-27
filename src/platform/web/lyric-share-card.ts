import type { LyricLine, Track } from '../../core/types'
import { LruCache } from '../../core/util/lru-cache'
import { shareCoverFallbackUrl } from '../../../shared/share-cover'

export interface LyricShareCardInput {
  track: Pick<Track, 'title' | 'artist' | 'album' | 'cover'>
  lines: readonly Pick<LyricLine, 'text' | 'translation'>[]
  includeTranslation: boolean
  timeLabel?: string
}

const CARD_WIDTH = 1080
const CARD_MAX_HEIGHT = 4096
const CARD_PADDING = 88
const COVER_SIZE = 96
const CONTENT_WIDTH = CARD_WIDTH - CARD_PADDING * 2
const IO_TIMEOUT = 8000
const COVER_FAILURE_TTL = 30_000
const failedCoverUntil = new LruCache<string, number>(32)
const BODY_FONT = 'Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
const TOO_LONG_MESSAGE = '这些歌词太长，无法完整生成图片，请减少选中的歌词。'
const COVER_ERROR_MESSAGE = '封面暂时无法载入，请重试。'
const graphemes =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null
const words =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null

interface TextRow {
  text: string
  font: string
  color: string
  x: number
  baseline: number
}

interface CardLayout {
  rows: TextRow[]
  height: number
  coverY: number
}

interface CardStyle {
  bodyFont: string
  text: string
  muted: string
  subtle: string
}

interface CardArtwork {
  url: string
  image: HTMLImageElement
  surfaces: HTMLCanvasElement[]
  background?: HTMLCanvasElement
  users: number
  retired: boolean
}

function createArtworkCache() {
  let cached: CardArtwork | null = null
  let generation = 0
  function release(artwork: CardArtwork): void {
    artwork.users = Math.max(0, artwork.users - 1)
    if (!artwork.retired || artwork.users) return
    artwork.image.removeAttribute('src')
    for (const surface of artwork.surfaces) surface.width = surface.height = 1
    artwork.surfaces.length = 0
    artwork.background = undefined
  }
  function clear(): void {
    generation += 1
    if (!cached) return
    cached.retired = true
    // Retiring the cached reference must not release an active encoder's lease.
    cached.users += 1
    release(cached)
    cached = null
  }
  return {
    generation: () => generation,
    acquire(url: string): CardArtwork | null {
      if (!cached || cached.url !== url) return null
      cached.users += 1
      return cached
    },
    remember(url: string, image: HTMLImageElement, startedAt: number): CardArtwork {
      if (startedAt !== generation) {
        return { url, image, surfaces: [], users: 1, retired: true }
      }
      clear()
      cached = { url, image, surfaces: [], users: 1, retired: false }
      return cached
    },
    discard(artwork: CardArtwork): void {
      artwork.retired = true
      if (cached === artwork) cached = null
    },
    clear,
    release,
  }
}

/** One cover and its tiny blurred field per open share session; no global image cache. */
export function createLyricShareCardRenderer() {
  const cache = createArtworkCache()
  return {
    render: (
      input: LyricShareCardInput,
      signal?: AbortSignal,
      options: { retryCover?: boolean } = {},
    ) => renderCard(input, signal, options, cache),
    clear: cache.clear,
  }
}

function readCardStyle(): CardStyle {
  const style = getComputedStyle(document.documentElement)
  return {
    bodyFont: style.fontFamily || BODY_FONT,
    text: style.getPropertyValue('--text').trim() || 'rgba(255, 255, 255, 0.92)',
    muted: style.getPropertyValue('--text-muted').trim() || 'rgba(255, 255, 255, 0.68)',
    subtle: style.getPropertyValue('--text-subtle').trim() || 'rgba(255, 255, 255, 0.43)',
  }
}

function abortError(): DOMException {
  return new DOMException('已取消生成歌词卡片', 'AbortError')
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function hasRecentCoverFailure(url: string | undefined): boolean {
  if (!url) return false
  const expiresAt = failedCoverUntil.get(url)
  if (expiresAt === undefined) return false
  if (expiresAt > Date.now()) return true
  failedCoverUntil.delete(url)
  return false
}

function splitGraphemes(text: string): string[] {
  if (graphemes) return Array.from(graphemes.segment(text), ({ segment }) => segment)
  // Older browsers still keep combining marks, emoji modifiers and ZWJ sequences intact.
  const result: string[] = []
  let regionalCount = 0
  for (const character of text) {
    const previous = result.at(-1)
    const regional = /\p{Regional_Indicator}/u.test(character)
    if (
      previous &&
      (/\p{Mark}|\p{Emoji_Modifier}|[\uFE0E\uFE0F\u200D]/u.test(character) ||
        previous.endsWith('\u200D') ||
        (regional && regionalCount % 2 === 1))
    ) {
      result[result.length - 1] = previous + character
    } else result.push(character)
    regionalCount = regional ? regionalCount + 1 : 0
  }
  return result
}

function measureWidth(context: CanvasRenderingContext2D, text: string): number {
  const metrics = context.measureText(text)
  return Math.max(
    metrics.width,
    (metrics.actualBoundingBoxLeft || 0) + (metrics.actualBoundingBoxRight || 0),
  )
}

function wrapText(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const result: string[] = []
  const append = (line: string): void => {
    result.push(line.trim())
    // Stop oversized input before it can allocate an enormous canvas or block the UI.
    if (result.length > 100) throw new Error(TOO_LONG_MESSAGE)
  }
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    const normalized = paragraph.replace(/[^\S\n]+/gu, ' ').trim()
    const tokens = words
      ? Array.from(words.segment(normalized), ({ segment }) => segment)
      : (normalized.match(
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|\s+/gu,
        ) ?? [])
    let line = ''
    for (const token of tokens) {
      const candidate = line + token
      if (measureWidth(context, candidate) <= width) {
        line = candidate
        continue
      }
      if (line.trim()) append(line)
      line = token.trimStart()
      if (measureWidth(context, line) <= width) continue
      let fragment = ''
      for (const character of splitGraphemes(line)) {
        if (measureWidth(context, character) > width) throw new Error(TOO_LONG_MESSAGE)
        if (fragment && measureWidth(context, fragment + character) > width) {
          append(fragment)
          fragment = ''
        }
        fragment += character
      }
      line = fragment
    }
    if (line.trim() || !normalized) append(line)
  }
  return result
}

function createLayout(
  context: CanvasRenderingContext2D,
  input: LyricShareCardInput,
  hasCover: boolean,
  style: CardStyle,
): CardLayout {
  const rows: TextRow[] = []
  const addText = (
    text: string,
    x: number,
    top: number,
    width: number,
    size: number,
    weight: number,
    lineHeight: number,
    color: string,
  ): number => {
    const font = `${weight} ${size}px ${style.bodyFont}`
    context.font = font
    for (const line of wrapText(context, text, width - 16)) {
      const metrics = context.measureText(line)
      const ascent = metrics.actualBoundingBoxAscent || size * 0.9
      const descent = metrics.actualBoundingBoxDescent || size * 0.25
      const height = Math.max(lineHeight, ascent + descent + 8)
      rows.push({
        text: line,
        font,
        color,
        x: x + 8,
        baseline: top + (height - ascent - descent) / 2 + ascent,
      })
      top += height
      if (top > CARD_MAX_HEIGHT - 170) throw new Error(TOO_LONG_MESSAGE)
    }
    return top
  }

  let top = CARD_PADDING + 16
  const lyricSize = input.lines.length <= 2 ? 68 : 60
  for (const [index, line] of input.lines.entries()) {
    if (index) top += 32
    top = addText(
      line.text.trim(),
      CARD_PADDING,
      top,
      CONTENT_WIDTH,
      lyricSize,
      700,
      lyricSize * 1.28,
      style.text,
    )
    if (input.includeTranslation && line.translation?.trim()) {
      top = addText(
        line.translation.trim(),
        CARD_PADDING,
        top + 12,
        CONTENT_WIDTH,
        30,
        400,
        42,
        style.muted,
      )
    }
  }
  const lyricRowCount = rows.length
  const metadataTop = top + 80
  const metadataX = CARD_PADDING + (hasCover ? COVER_SIZE + 24 : 0)
  const metadataWidth = CARD_WIDTH - CARD_PADDING - metadataX
  let metadataBottom = addText(
    input.track.title.trim() || '未命名歌曲',
    metadataX,
    metadataTop,
    metadataWidth,
    34,
    600,
    44,
    style.text,
  )
  metadataBottom = addText(
    input.track.artist.trim() || '未知歌手',
    metadataX,
    metadataBottom + 6,
    metadataWidth,
    26,
    400,
    36,
    style.muted,
  )
  const footerTop = Math.max(metadataBottom, metadataTop + (hasCover ? COVER_SIZE : 0)) + 64
  let bottom = addText(
    'Meliora',
    CARD_PADDING,
    footerTop,
    CONTENT_WIDTH / 2,
    22,
    500,
    32,
    style.subtle,
  )
  if (input.timeLabel?.trim()) {
    const timeRowStart = rows.length
    bottom = Math.max(
      bottom,
      addText(input.timeLabel.trim(), 0, footerTop, CONTENT_WIDTH / 2, 22, 400, 32, style.subtle),
    )
    for (const row of rows.slice(timeRowStart)) {
      context.font = row.font
      row.x = CARD_WIDTH - CARD_PADDING - 8 - measureWidth(context, row.text)
    }
  }
  const naturalHeight = Math.ceil(bottom + CARD_PADDING)
  const height = Math.max(640, naturalHeight)
  if (height > CARD_MAX_HEIGHT) throw new Error(TOO_LONG_MESSAGE)
  const extra = height - naturalHeight
  // Give short excerpts breathing room without leaving a poster-sized empty footer.
  rows.forEach((row, index) => {
    row.baseline += index < lyricRowCount ? extra * 0.4 : extra
  })
  return { rows, height, coverY: metadataTop + extra }
}

function loadCover(
  url: string | undefined,
  signal?: AbortSignal,
): Promise<HTMLImageElement | null> {
  checkAbort(signal)
  if (!url || hasRecentCoverFailure(url) || typeof Image === 'undefined')
    return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const image = new Image()
    let settled = false
    const finish = (loaded: boolean, aborted = false): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      image.onload = image.onerror = null
      if (!loaded) image.removeAttribute('src')
      if (aborted) reject(abortError())
      else {
        if (loaded) failedCoverUntil.delete(url)
        else failedCoverUntil.set(url, Date.now() + COVER_FAILURE_TTL)
        resolve(loaded ? image : null)
      }
    }
    const abort = (): void => finish(false, true)
    const timer = setTimeout(() => finish(false), IO_TIMEOUT)
    signal?.addEventListener('abort', abort, { once: true })
    image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    image.onload = (): void => {
      void Promise.resolve()
        .then(() => (!settled && typeof image.decode === 'function' ? image.decode() : undefined))
        .catch(() => {})
        .then(() => finish(image.naturalWidth > 0 && image.naturalHeight > 0))
    }
    // Never retry without CORS: that would taint the canvas and prevent PNG export.
    image.onerror = (): void => finish(false)
    try {
      image.src = url
    } catch {
      finish(false)
    }
  })
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.arcTo(x + width, y, x + width, y + height, radius)
  context.arcTo(x + width, y + height, x, y + height, radius)
  context.arcTo(x, y + height, x, y, radius)
  context.arcTo(x, y, x + width, y, radius)
  context.closePath()
}

function drawCoverBackground(
  context: CanvasRenderingContext2D,
  artwork: CardArtwork,
  height: number,
): void {
  const cover = artwork.image
  // Blur a tiny color field, not a full-resolution cover. The downsample also
  // keeps the backdrop soft on browsers without CanvasRenderingContext2D.filter.
  if (!artwork.background) {
    const sample = document.createElement('canvas')
    const softened = document.createElement('canvas')
    sample.width = sample.height = 16
    softened.width = softened.height = 64
    // Keep source surfaces intact until PNG encoding completes; some canvas
    // backends defer rasterizing drawImage until the destination is read.
    artwork.surfaces.push(sample, softened)
    const sampleContext = sample.getContext('2d')
    const softContext = softened.getContext('2d')
    if (!sampleContext || !softContext) return
    const side = Math.min(cover.naturalWidth, cover.naturalHeight)
    sampleContext.drawImage(
      cover,
      (cover.naturalWidth - side) / 2,
      (cover.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      16,
      16,
    )
    softContext.imageSmoothingEnabled = true
    softContext.imageSmoothingQuality = 'high'
    softContext.filter = 'blur(3px)'
    softContext.drawImage(sample, -16, -16, 96, 96)
    artwork.background = softened
  }
  context.save()
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(artwork.background, 0, 0, CARD_WIDTH, height)
  // Keep even a white cover dark enough for the smaller translated lyrics.
  context.fillStyle = 'rgba(14, 13, 18, 0.72)'
  context.fillRect(0, 0, CARD_WIDTH, height)
  context.restore()
}

function drawCard(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  layout: CardLayout,
  artwork: CardArtwork | null,
): void {
  // Resizing also resets the origin-clean flag when a cover failed export.
  canvas.width = CARD_WIDTH
  canvas.height = layout.height
  context.fillStyle = 'rgb(21, 19, 24)'
  context.fillRect(0, 0, CARD_WIDTH, layout.height)
  if (artwork) drawCoverBackground(context, artwork, layout.height)
  const background = context.createLinearGradient(0, 0, 0, layout.height)
  background.addColorStop(0, 'rgba(255, 255, 255, 0.025)')
  background.addColorStop(1, 'rgba(0, 0, 0, 0.24)')
  context.fillStyle = background
  context.fillRect(0, 0, CARD_WIDTH, layout.height)

  if (artwork) {
    const cover = artwork.image
    context.save()
    roundedRect(context, CARD_PADDING + 8, layout.coverY, COVER_SIZE, COVER_SIZE, 18)
    context.clip()
    const side = Math.min(cover.naturalWidth, cover.naturalHeight)
    context.drawImage(
      cover,
      (cover.naturalWidth - side) / 2,
      (cover.naturalHeight - side) / 2,
      side,
      side,
      CARD_PADDING + 8,
      layout.coverY,
      COVER_SIZE,
      COVER_SIZE,
    )
    context.restore()
  }
  context.textBaseline = 'alphabetic'
  context.textAlign = 'left'
  for (const row of layout.rows) {
    context.font = row.font
    context.fillStyle = row.color
    context.fillText(row.text, row.x, row.baseline)
  }
}

function encodePng(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (blob: Blob | null, error?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else if (blob) resolve(blob)
      else reject(new Error('图片生成失败，请减少选中的歌词后重试。'))
    }
    const abort = (): void => finish(null, abortError())
    const timer = setTimeout(() => finish(null), IO_TIMEOUT)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      canvas.toBlob((blob) => finish(blob), 'image/png')
    } catch (error) {
      finish(null, error)
    }
  })
}

/** The returned PNG is used both for preview and download, so they never diverge. */
export async function renderLyricShareCard(
  input: LyricShareCardInput,
  signal?: AbortSignal,
  options: { retryCover?: boolean } = {},
): Promise<Blob> {
  const renderer = createLyricShareCardRenderer()
  try {
    return await renderer.render(input, signal, options)
  } finally {
    renderer.clear()
  }
}

async function renderCard(
  input: LyricShareCardInput,
  signal: AbortSignal | undefined,
  options: { retryCover?: boolean },
  cache: ReturnType<typeof createArtworkCache>,
): Promise<Blob> {
  checkAbort(signal)
  if (
    input.lines.length < 1 ||
    input.lines.length > 6 ||
    input.lines.some((line) => !line.text.trim())
  ) {
    throw new Error('请选择 1 到 6 句有文字的歌词。')
  }
  const textLength =
    input.track.title.length +
    input.track.artist.length +
    (input.timeLabel?.length ?? 0) +
    input.lines.reduce(
      (total, line) =>
        total + line.text.length + (input.includeTranslation ? (line.translation?.length ?? 0) : 0),
      0,
    )
  if (textLength > 6000) throw new Error(TOO_LONG_MESSAGE)
  if (typeof document === 'undefined') throw new Error('当前环境不支持生成歌词图片。')
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context || typeof canvas.toBlob !== 'function') {
    throw new Error('当前浏览器不支持生成歌词图片。')
  }
  let artwork: CardArtwork | null = null
  try {
    const style = readCardStyle()
    // Reject oversized content before spending time loading its cover.
    const expectsCover = Boolean(input.track.cover)
    const initialLayout = createLayout(context, input, expectsCover, style)
    if (input.track.cover) {
      const fallback = shareCoverFallbackUrl(input.track.cover, import.meta.env?.DEV)
      const candidates = fallback ? [input.track.cover, fallback] : [input.track.cover]
      if (options.retryCover) {
        cache.clear()
        candidates.forEach((url) => failedCoverUntil.delete(url))
      }
      for (const url of candidates) {
        artwork = cache.acquire(url)
        if (!artwork) {
          const startedAt = cache.generation()
          const cover = await loadCover(url, signal)
          if (signal?.aborted) {
            cover?.removeAttribute('src')
            checkAbort(signal)
          }
          if (cover) artwork = cache.remember(url, cover, startedAt)
        }
        checkAbort(signal)
        if (!artwork) continue
        try {
          drawCard(canvas, context, initialLayout, artwork)
          return await encodePng(canvas, signal)
        } catch (error) {
          checkAbort(signal)
          if (!(error instanceof DOMException && error.name === 'SecurityError')) throw error
          failedCoverUntil.set(url, Date.now() + COVER_FAILURE_TTL)
          cache.discard(artwork)
        } finally {
          cache.release(artwork)
          artwork = null
        }
      }
      // Never silently export an incomplete card when artwork was requested.
      throw new Error(COVER_ERROR_MESSAGE)
    }
    cache.clear()
    drawCard(canvas, context, initialLayout, null)
    return await encodePng(canvas, signal)
  } catch (error) {
    checkAbort(signal)
    if (error instanceof Error && [TOO_LONG_MESSAGE, COVER_ERROR_MESSAGE].includes(error.message))
      throw error
    throw new Error('图片生成失败，请减少选中的歌词后重试。', { cause: error })
  } finally {
    if (artwork) cache.release(artwork)
    canvas.width = canvas.height = 1
  }
}
