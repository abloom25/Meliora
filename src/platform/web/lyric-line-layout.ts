import { balanceLyricBreaks } from '../../core/lyrics/line-breaks'
import { LruCache } from '../../core/util/lru-cache'
import type { LyricWord } from '../../core/types'

const FONT_PROPERTIES = [
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-stretch',
  'font-variant',
  'font-feature-settings',
  'font-variation-settings',
  'letter-spacing',
  'word-spacing',
]
type Width = { text: string; width: number; gap: number; constrained: boolean }
interface RowMeasurement {
  elements: readonly HTMLElement[]
  words: readonly LyricWord[]
  signature: string
  available: number
  widths: Width[]
  breaks: number[]
}

/** Instance-owned caches: unrelated documents and font lifetimes never share measurements. */
export function createLyricLineMeasurer() {
  let rows = new WeakMap<HTMLElement, RowMeasurement>()
  const spaces = new LruCache<string, number>(32)

  function measureSpace(style: CSSStyleDeclaration, doc: Document, key: string): number {
    const cached = spaces.get(key)
    if (cached !== undefined) return cached
    const probe = doc.createElement('span')
    probe.textContent = ' '
    probe.style.cssText =
      'all:initial;position:absolute;visibility:hidden;display:inline-block;white-space:pre;pointer-events:none;width:max-content'
    for (const property of FONT_PROPERTIES)
      probe.style.setProperty(property, style.getPropertyValue(property))
    doc.body.append(probe)
    const width = Number.parseFloat(doc.defaultView!.getComputedStyle(probe).width)
    probe.remove()
    const gap = Number.isFinite(width) ? width : (Number.parseFloat(style.fontSize) || 16) * 0.25
    spaces.set(key, gap)
    return gap
  }

  function measure(
    elements: readonly HTMLElement[],
    words: readonly LyricWord[],
    available: number,
  ): number[] {
    const first = elements[0]
    if (!first || elements.length !== words.length || available <= 0 || !first.isConnected)
      return []
    const doc = first.ownerDocument
    const view = doc.defaultView
    if (!view) return []
    // Words in a lyric row inherit typography. One style read validates the whole row.
    const firstStyle = view.getComputedStyle(first)
    const signature = [
      ...FONT_PROPERTIES.map((property) => firstStyle.getPropertyValue(property)),
      doc.fonts?.status,
    ].join('|')
    const previous = rows.get(first)
    const reusable =
      previous?.words === words &&
      previous.signature === signature &&
      previous.elements.length === elements.length &&
      previous.elements.every((element, index) => element === elements[index])
    if (reusable && previous.available === available) return previous.breaks
    const widths = elements.map((element, index): Width => {
      const cached = reusable ? previous.widths[index] : undefined
      // A word constrained by the old container can acquire a different natural line count.
      if (cached && !cached.constrained && cached.width < available - 1) return cached
      const style = index === 0 ? firstStyle : view.getComputedStyle(element)
      const padding =
        (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
      const contentWidth = Number.parseFloat(style.width)
      const width =
        Number.isFinite(contentWidth) && style.boxSizing !== 'border-box'
          ? contentWidth
          : element.clientWidth - padding
      const lineHeight =
        Number.parseFloat(style.lineHeight) || (Number.parseFloat(style.fontSize) || 16) * 1.2
      const paddingY =
        (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
      return {
        text: words[index]!.text,
        width,
        gap: words[index]!.trailingSpace ? measureSpace(firstStyle, doc, signature) : 0,
        constrained: width >= available - 1 || element.clientHeight - paddingY > lineHeight * 1.5,
      }
    })
    if (widths.some((word) => word.width <= 0)) return []
    const breaks = balanceLyricBreaks(widths, available)
    rows.set(first, { elements: [...elements], words, signature, available, widths, breaks })
    return breaks
  }

  return {
    measure,
    invalidate(): void {
      rows = new WeakMap()
      spaces.clear()
    },
  }
}

export function measureLyricBreaks(
  elements: readonly HTMLElement[],
  words: readonly LyricWord[],
  available: number,
): number[] {
  return createLyricLineMeasurer().measure(elements, words, available)
}
