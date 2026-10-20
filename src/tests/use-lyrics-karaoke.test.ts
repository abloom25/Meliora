import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLyricsKaraoke } from '../composables/useLyricsKaraoke'
import { scheduleLyricRender } from '../core/lyrics/render-schedule'
import { lyricWordCharacters } from '../core/lyrics/word-motion'
import type { LyricLine } from '../core/types'

function createLine(line: LyricLine): HTMLElement {
  const element = document.createElement('div')
  for (const word of line.words ?? []) {
    const span = document.createElement('span')
    span.className = 'lyric-word'
    const characters = lyricWordCharacters(word)
    if (characters) {
      for (const text of characters) {
        const character = document.createElement('span')
        character.className = 'lyric-char'
        character.textContent = text
        span.append(character)
      }
    } else {
      span.textContent = word.text
    }
    element.append(span)
  }
  document.body.append(element)
  return element
}

function spans(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>('.lyric-word')]
}

function fills(element: HTMLElement): string[] {
  return spans(element).map((span) => span.style.getPropertyValue('--lyric-word-fill'))
}

const lead: LyricLine = {
  time: 0,
  endTime: 4,
  text: 'lead voice',
  words: [
    { time: 0, duration: 2, text: 'lead' },
    { time: 2, duration: 2, text: 'voice' },
  ],
}
const harmony: LyricLine = {
  time: 1,
  endTime: 4,
  text: 'harmony',
  background: true,
  words: [{ time: 1, duration: 3, text: 'harmony' }],
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('useLyricsKaraoke', () => {
  it('writes independent rise after a short word is fully lit and rewinds both on seek', () => {
    const line: LyricLine = {
      time: 0,
      text: 'you',
      words: [{ time: 0, duration: 0.2, text: 'you' }],
    }
    const element = createLine(line)
    const karaoke = useLyricsKaraoke({
      getLines: () => [line],
      getLineElements: () => [element],
      isEnabled: () => true,
    })
    karaoke.bind([0])
    karaoke.write(0.5)
    const word = spans(element)[0]!
    expect(fills(element)).toEqual(['1.000'])
    expect(word.style.getPropertyValue('--lyric-word-rise')).toBe('0.875')
    const write = vi.spyOn(word.style, 'setProperty')
    karaoke.write(0.5)
    expect(write).not.toHaveBeenCalled()
    karaoke.write(0)
    expect(fills(element)).toEqual(['0.000'])
    expect(word.style.getPropertyValue('--lyric-word-rise')).toBe('0.000')
  })

  it('repairs replaced emphasis characters and clears all motion on row exit', () => {
    const element = createLine(lead)
    const karaoke = useLyricsKaraoke({
      getLines: () => [lead],
      getLineElements: () => [element],
      isEnabled: () => true,
    })
    karaoke.bind([0])
    karaoke.write(1)
    const word = spans(element)[0]!
    const original = word.querySelector<HTMLElement>('.lyric-char')!
    expect(Number(original.style.getPropertyValue('--lyric-char-emphasis'))).toBeGreaterThan(0)
    const replacement = original.cloneNode(true) as HTMLElement
    replacement.removeAttribute('style')
    original.replaceWith(replacement)
    karaoke.ensure([0])
    karaoke.write(1)
    expect(Number(replacement.style.getPropertyValue('--lyric-char-emphasis'))).toBeGreaterThan(0)
    expect(original.style.getPropertyValue('--lyric-char-emphasis')).toBe('')
    karaoke.ensure([])
    expect(word.style.getPropertyValue('--lyric-word-rise')).toBe('')
    expect(replacement.style.getPropertyValue('--lyric-char-emphasis')).toBe('')
  })

  it('binds emphasis added after the word node and freezes it at the paused media time', () => {
    const element = createLine(lead)
    const word = spans(element)[0]!
    const characters = [...word.children]
    word.replaceChildren(document.createTextNode('lead'))
    const karaoke = useLyricsKaraoke({
      getLines: () => [lead],
      getLineElements: () => [element],
      isEnabled: () => true,
    })
    karaoke.bind([0])
    karaoke.write(0.5)
    word.replaceChildren(...characters)
    karaoke.ensure([0])
    karaoke.write(0.5)
    const character = characters[0] as HTMLElement
    expect(Number(character.style.getPropertyValue('--lyric-char-emphasis'))).toBeGreaterThan(0)
    const value = character.style.getPropertyValue('--lyric-char-emphasis')
    const write = vi.spyOn(character.style, 'setProperty')
    karaoke.ensure([0])
    karaoke.write(0.5)
    expect(write).not.toHaveBeenCalled()
    expect(character.style.getPropertyValue('--lyric-char-emphasis')).toBe(value)
  })

  it('clears rise and emphasis immediately when motion is disabled', () => {
    let enabled = true
    const element = createLine(lead)
    const karaoke = useLyricsKaraoke({
      getLines: () => [lead],
      getLineElements: () => [element],
      isEnabled: () => enabled,
    })
    karaoke.bind([0])
    karaoke.write(1)
    enabled = false
    karaoke.write(1)
    expect(spans(element).every((word) => !word.style.getPropertyValue('--lyric-word-rise'))).toBe(
      true,
    )
    expect(
      [...element.querySelectorAll<HTMLElement>('.lyric-char')].every(
        (character) => !character.style.getPropertyValue('--lyric-char-emphasis'),
      ),
    ).toBe(true)
  })

  it('repairs a replaced harmony while keeping the connected lead binding intact', () => {
    const elements = [createLine(lead), createLine(harmony)]
    const karaoke = useLyricsKaraoke({
      getLines: () => [lead, harmony],
      getLineElements: () => elements,
      isEnabled: () => true,
    })
    karaoke.bind([0, 1])
    karaoke.write(2.5)
    expect(fills(elements[0]!)).toEqual(['1.000', '0.250'])
    expect(fills(elements[1]!)).toEqual(['0.500'])
    const oldHarmony = elements[1]!
    oldHarmony.remove()
    elements[1] = createLine(harmony)
    const leadWrite = vi.spyOn(spans(elements[0]!)[1]!.style, 'setProperty')
    const leadQuery = vi.spyOn(elements[0]!, 'querySelectorAll')

    karaoke.ensure([0, 1])
    karaoke.write(2.5)

    expect(fills(elements[1]!)).toEqual(['0.500'])
    expect(fills(oldHarmony)).toEqual([''])
    expect(leadQuery).not.toHaveBeenCalled()
    expect(leadWrite).not.toHaveBeenCalled()
  })

  it('repairs a later word replacement when the first word and row stay mounted', () => {
    const element = createLine(lead)
    const karaoke = useLyricsKaraoke({
      getLines: () => [lead],
      getLineElements: () => [element],
      isEnabled: () => true,
    })
    karaoke.bind([0])
    karaoke.write(3)
    const original = spans(element)
    const replacement = original[1]!.cloneNode(true) as HTMLElement
    replacement.removeAttribute('style')
    original[1]!.replaceWith(replacement)

    karaoke.ensure([0])
    karaoke.write(3)

    expect(spans(element)[0]).toBe(original[0])
    expect(fills(element)).toEqual(['1.000', '0.500'])
    expect(original[1]!.style.getPropertyValue('--lyric-word-fill')).toBe('')
  })

  it('binds mounted voices independently and keeps missing voices in render scheduling', () => {
    const leadElement = createLine(lead)
    const elements: Array<HTMLElement | undefined> = [leadElement]
    const karaoke = useLyricsKaraoke({
      getLines: () => [lead, harmony],
      getLineElements: () => elements,
      isEnabled: () => true,
    })
    karaoke.bind([0, 1])
    karaoke.write(2.5)
    expect(fills(leadElement)).toEqual(['1.000', '0.250'])
    expect(karaoke.getWords()).toEqual([...lead.words!, ...harmony.words!])
    expect(
      scheduleLyricRender(
        { timeSeconds: 2.5, playing: true, playbackRate: 1, seeking: false },
        null,
        karaoke.getWords(),
        true,
      ),
    ).toEqual({ kind: 'frame' })

    const leadWrite = vi.spyOn(spans(leadElement)[1]!.style, 'setProperty')
    const leadQuery = vi.spyOn(leadElement, 'querySelectorAll')
    karaoke.ensure([0, 1])
    karaoke.write(2.5)
    expect(leadQuery).not.toHaveBeenCalled()
    expect(leadWrite).not.toHaveBeenCalled()

    elements[1] = createLine(harmony)
    karaoke.ensure([0, 1])
    karaoke.write(2.5)
    expect(fills(elements[1])).toEqual(['0.500'])
  })

  it('retries mismatched word nodes without interrupting another active voice', () => {
    const elements = [createLine(lead), createLine(harmony)]
    elements[1]!.replaceChildren()
    const karaoke = useLyricsKaraoke({
      getLines: () => [lead, harmony],
      getLineElements: () => elements,
      isEnabled: () => true,
    })
    karaoke.bind([0, 1])
    karaoke.write(2.5)
    expect(fills(elements[0]!)).toEqual(['1.000', '0.250'])

    const word = document.createElement('span')
    word.className = 'lyric-word'
    elements[1]!.append(word)
    karaoke.ensure([0, 1])
    karaoke.write(2.5)
    expect(fills(elements[1]!)).toEqual(['0.500'])
  })

  it('detects changed timing data with the same active row and word count', () => {
    let lines = [lead]
    const element = createLine(lead)
    const karaoke = useLyricsKaraoke({
      getLines: () => lines,
      getLineElements: () => [element],
      isEnabled: () => true,
    })
    karaoke.bind([0])
    karaoke.write(3)
    expect(fills(element)).toEqual(['1.000', '0.500'])
    lines = [
      {
        ...lead,
        words: [
          { time: 2, duration: 2, text: 'lead' },
          { time: 4, duration: 2, text: 'voice' },
        ],
      },
    ]

    karaoke.ensure([0])
    karaoke.write(3)
    expect(fills(element)).toEqual(['0.500', '0.000'])
    expect(karaoke.getWords()).toEqual(lines[0]!.words)
  })

  it('uses the current virtual row even if its previous DOM remains connected', () => {
    const previous = createLine(lead)
    let current = previous
    const karaoke = useLyricsKaraoke({
      getLines: () => [lead],
      getLineElements: () => [previous, current],
      getLineElement: () => current,
      isEnabled: () => true,
    })
    karaoke.bind([0])
    karaoke.write(1)
    current = createLine(lead)
    karaoke.ensure([0])
    karaoke.write(1)

    expect(fills(current)).toEqual(['0.500', '0.000'])
    expect(fills(previous)).toEqual(['', ''])
  })

  it('releases styles when disabled and restores the same active row on re-enable', () => {
    let enabled = true
    const element = createLine(lead)
    const karaoke = useLyricsKaraoke({
      getLines: () => [lead],
      getLineElements: () => [element],
      isEnabled: () => enabled,
    })
    karaoke.bind([0])
    karaoke.write(1)
    enabled = false
    karaoke.ensure([0])
    expect(fills(element)).toEqual(['', ''])
    expect(karaoke.getWords()).toEqual([])
    enabled = true
    karaoke.ensure([0])
    karaoke.write(1)
    expect(fills(element)).toEqual(['0.500', '0.000'])

    enabled = false
    karaoke.write(1.5)
    expect(fills(element)).toEqual(['', ''])
    enabled = true
    karaoke.ensure([0])
    karaoke.write(1.5)
    expect(fills(element)).toEqual(['0.750', '0.000'])
  })

  it('snaps zero-duration words at their timestamp and reverses correctly on seek', () => {
    const instant: LyricLine = {
      time: 2,
      text: 'instant',
      words: [{ time: 2, duration: 0, text: 'instant' }],
    }
    const element = createLine(instant)
    const karaoke = useLyricsKaraoke({
      getLines: () => [instant],
      getLineElements: () => [element],
      isEnabled: () => true,
    })
    karaoke.bind([0])
    karaoke.write(1.9)
    expect(fills(element)).toEqual(['0.000'])
    karaoke.write(2)
    expect(fills(element)).toEqual(['1.000'])
    karaoke.write(1.9)
    expect(fills(element)).toEqual(['0.000'])
    expect(spans(element)[0]!.style.getPropertyValue('--lyric-word-edge')).toBe('0.000')
  })

  it('rewrites replaced nodes at the paused media time without advancing the envelope', () => {
    const element = createLine(lead)
    const karaoke = useLyricsKaraoke({
      getLines: () => [lead],
      getLineElements: () => [element],
      isEnabled: () => true,
    })
    karaoke.bind([0])
    karaoke.write(0.5)
    element.replaceChildren(...spans(element).map((span) => span.cloneNode(true)))
    karaoke.bind([0])
    karaoke.write(0.5)
    expect(fills(element)).toEqual(['0.250', '0.000'])
    karaoke.write(Number.NaN)
    expect(fills(element)).toEqual(['0.250', '0.000'])
  })

  it('cleans detached nodes on release before they can be reused', () => {
    const element = createLine(lead)
    const karaoke = useLyricsKaraoke({
      getLines: () => [lead],
      getLineElements: () => [element],
      isEnabled: () => true,
    })
    karaoke.bind([0])
    karaoke.write(1)
    element.remove()
    karaoke.release()
    document.body.append(element)
    expect(fills(element)).toEqual(['', ''])
    expect(karaoke.getWords()).toEqual([])
  })

  it('releases a completed voice and preserves another voice when active rows change', () => {
    const elements = [createLine(lead), createLine(harmony)]
    const karaoke = useLyricsKaraoke({
      getLines: () => [lead, harmony],
      getLineElements: () => elements,
      isEnabled: () => true,
    })
    karaoke.bind([0, 1])
    karaoke.write(2.5)
    karaoke.ensure([1])
    karaoke.write(3)
    expect(fills(elements[0]!)).toEqual(['', ''])
    expect(fills(elements[1]!)).toEqual(['0.667'])
    expect(karaoke.getWords()).toEqual(harmony.words)
    karaoke.ensure([])
    expect(fills(elements[1]!)).toEqual([''])
    expect(karaoke.getWords()).toEqual([])
  })
})
