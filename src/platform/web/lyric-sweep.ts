import { createLyricSweep, type LyricWordGeometry } from '../../core/lyrics/sweep'
import type { LyricWord } from '../../core/types'

interface MeasuredWord extends LyricWordGeometry {
  boxWidth: number
  fade: number
}

function geometryKey(element: HTMLElement): string {
  const view = element.ownerDocument.defaultView
  if (!view || !element.isConnected) return ''
  const style = view.getComputedStyle(element)
  return [
    element.clientWidth,
    element.clientHeight,
    style.font,
    style.fontFamily,
    style.fontSize,
    style.fontWeight,
    style.fontStretch,
    style.fontFeatureSettings,
    style.fontVariationSettings,
    style.letterSpacing,
    style.wordSpacing,
    style.fontVariant,
    style.paddingLeft,
    style.paddingRight,
    element.ownerDocument.fonts?.status,
  ].join('|')
}

/** Text-only ranges exclude emphasis padding; ratios cancel the parent line's spring scale. */
function measureWord(element: HTMLElement, word: LyricWord): MeasuredWord | null {
  const view = element.ownerDocument.defaultView
  if (!view || !element.isConnected || element.clientWidth <= 0) return null
  const style = view.getComputedStyle(element)
  const padding =
    (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
  const width = element.clientWidth - padding
  if (width <= 0) return null
  const fontSize = Number.parseFloat(style.fontSize) || 16
  const range = element.ownerDocument.createRange()
  if (typeof range.getBoundingClientRect !== 'function') return null
  const walker = element.ownerDocument.createTreeWalker(element, 4)
  const leaves: Text[] = []
  while (walker.nextNode()) leaves.push(walker.currentNode as Text)
  const prefixWidth = (length: number): number => {
    let result = 0
    for (const leaf of leaves) {
      if (length <= 0) break
      const end = Math.min(length, leaf.length)
      range.setStart(leaf, 0)
      range.setEnd(leaf, end)
      result += range.getBoundingClientRect().width
      length -= end
    }
    return result
  }
  let offset = 0
  let previous = 0
  const syllableWidths = word.syllables?.map((syllable) => {
    offset += syllable.text.length
    const next = prefixWidth(offset)
    const measured = next - previous
    previous = next
    return measured
  })
  return { width, boxWidth: element.clientWidth, fade: fontSize * 0.55, syllableWidths }
}

export interface LyricSweepBinding {
  write: (index: number, time: number) => number
  refresh: () => boolean
  clear: () => void
}

/** Fixed gradients move over cached text geometry. Media time remains the only animation clock. */
export function bindLyricSweep(
  elements: readonly HTMLElement[],
  words: readonly LyricWord[],
): LyricSweepBinding {
  let keys = elements.map(geometryKey)
  let measured = elements.map((element, index) => measureWord(element, words[index]!))
  let sweep = createLyricSweep(
    words,
    measured.map((entry) => entry ?? { width: 0 }),
  )
  const lastPositions = elements.map(() => '')
  const lastTimes: Array<number | undefined> = elements.map(() => undefined)
  function install(): void {
    for (const [index, element] of elements.entries()) {
      const entry = measured[index]
      if (!entry) {
        delete element.dataset.lyricSweep
        continue
      }
      element.dataset.lyricSweep = ''
      element.style.setProperty('--lyric-sweep-span', `${entry.boxWidth}px`)
      element.style.setProperty('--lyric-sweep-fade', `${entry.fade}px`)
      element.style.setProperty('--lyric-sweep-size', `${entry.boxWidth * 2 + entry.fade}px`)
    }
  }
  function write(index: number, time: number): number {
    lastTimes[index] = time
    const progress = sweep.progress(index, time)
    const entry = measured[index]
    if (entry) {
      const position = `${((progress - 1) * (entry.boxWidth + entry.fade)).toFixed(3)}px`
      if (position !== lastPositions[index]) {
        elements[index]!.style.setProperty('--lyric-sweep-position', position)
        lastPositions[index] = position
      }
    }
    return progress
  }
  install()
  return {
    write,
    refresh() {
      const next = elements.map(geometryKey)
      if (next.every((key, index) => key === keys[index])) return false
      measured = measured.map((entry, index) =>
        next[index] === keys[index] ? entry : measureWord(elements[index]!, words[index]!),
      )
      keys = next
      sweep = createLyricSweep(
        words,
        measured.map((entry) => entry ?? { width: 0 }),
      )
      install()
      lastPositions.fill('')
      // Resizing while paused must preserve exactly the same media-time sample.
      for (const [index, time] of lastTimes.entries()) if (time !== undefined) write(index, time)
      return true
    },
    clear() {
      for (const element of elements) {
        delete element.dataset.lyricSweep
        for (const name of ['span', 'fade', 'size', 'position']) {
          element.style.removeProperty(`--lyric-sweep-${name}`)
        }
      }
    },
  }
}
