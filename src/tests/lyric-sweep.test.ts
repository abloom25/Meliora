import { describe, expect, it, vi } from 'vitest'
import { createLyricSweep } from '../core/lyrics/sweep'
import { mergeSyllablesIntoWords, shiftLyricTimings, wordFillProgress } from '../core/lyrics'
import { bindLyricSweep } from '../platform/web/lyric-sweep'

describe('native lyric sweeps', () => {
  const [word] = mergeSyllablesIntoWords([
    { time: 1, duration: 0.2, text: 'to' },
    { time: 2, duration: 0.5, text: 'day' },
  ])

  it('uses measured syllable widths and holds the exact same front during a pause', () => {
    const sweep = createLyricSweep([word!], [{ width: 100, syllableWidths: [25, 75] }])
    expect(sweep.progress(0, 0)).toBe(0)
    expect(sweep.progress(0, 1.1)).toBeCloseTo(0.125)
    expect(sweep.progress(0, 1.4)).toBeCloseTo(0.25)
    expect(sweep.progress(0, 1.8)).toBeCloseTo(0.25)
    expect(sweep.progress(0, 2.25)).toBeCloseTo(0.625)
    expect(sweep.progress(0, 3)).toBe(1)
    expect(sweep.progress(0, 1.8)).toBeCloseTo(0.25)
  })

  it('keeps the final word full and the next one dark across a line-internal rest', () => {
    const words = [
      { time: 1, duration: 1, text: 'hello' },
      { time: 4, duration: 1, text: 'world' },
    ]
    const sweep = createLyricSweep(words, [{ width: 80 }, { width: 120 }])
    expect([sweep.progress(0, 3), sweep.progress(1, 3)]).toEqual([1, 0])
    expect(sweep.progress(1, 4.5)).toBeCloseTo(0.5)
  })

  it('does not flatten overlapping syllables into one chronological cursor', () => {
    const words = [
      { time: 1, duration: 2, text: 'a' },
      { time: 2, duration: 2, text: 'b' },
    ]
    const sweep = createLyricSweep(words, [{ width: 40 }, { width: 20 }])
    expect(sweep.progress(0, 2.5)).toBeCloseTo(0.75)
    expect(sweep.progress(1, 2.5)).toBeCloseTo(0.25)
  })

  it('shifts nested timing with calibration without changing cached source data', () => {
    const source = [{ time: 1, text: 'today', words: [word!] }]
    const shifted = shiftLyricTimings(source, -0.3)[0]!.words![0]!
    expect(shifted.syllables!.map((part) => part.time)).toEqual([0.7, 1.7])
    expect(wordFillProgress(1.1, shifted)).toBeCloseTo(wordFillProgress(1.4, word!))
    expect(source[0]!.words[0]!.syllables![0]!.time).toBe(1)
  })

  it('falls back to retained syllables when geometry is unavailable', () => {
    const element = document.createElement('span')
    element.textContent = 'today'
    const binding = bindLyricSweep([element], [word!])
    expect(binding.write(0, 1.4)).toBeCloseTo(0.4)
    expect(binding.write(0, 1.8)).toBeCloseTo(0.4)
    expect(element.hasAttribute('data-lyric-sweep')).toBe(false)
    binding.clear()
  })

  it('moves a fixed gradient without remeasuring geometry on playback frames', () => {
    const element = document.createElement('span')
    element.textContent = 'today'
    element.style.cssText = 'font-size: 20px; padding: 0 2px'
    document.body.append(element)
    Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => 104 })
    const createRange = vi.spyOn(document, 'createRange').mockImplementation(() => {
      let end = 0
      return {
        setStart: () => {},
        setEnd: (_node: Node, offset: number) => {
          end = offset
        },
        getBoundingClientRect: () => ({ width: end === 2 ? 25 : 100 }),
      } as unknown as Range
    })
    try {
      const binding = bindLyricSweep([element], [word!])
      expect(element.dataset.lyricSweep).toBe('')
      expect(binding.write(0, 1.4)).toBeCloseTo(0.25)
      const pausedPosition = element.style.getPropertyValue('--lyric-sweep-position')
      binding.write(0, 1.8)
      expect(element.style.getPropertyValue('--lyric-sweep-position')).toBe(pausedPosition)
      binding.write(0, 2.5)
      expect(element.style.getPropertyValue('--lyric-sweep-position')).toBe('0.000px')
      expect(createRange).toHaveBeenCalledTimes(1)
      binding.clear()
      expect(element.hasAttribute('data-lyric-sweep')).toBe(false)
      expect(element.style.getPropertyValue('--lyric-sweep-position')).toBe('')
    } finally {
      element.remove()
      createRange.mockRestore()
    }
  })

  it('remeasures only changed word geometry and preserves the paused sweep position', () => {
    const elements = [document.createElement('span'), document.createElement('span')]
    let width = 100
    for (const [index, element] of elements.entries()) {
      element.textContent = 'today'
      element.style.fontSize = '20px'
      Object.defineProperty(element, 'clientWidth', { get: () => (index === 0 ? width : 100) })
      document.body.append(element)
    }
    const range = vi.spyOn(document, 'createRange').mockImplementation(() => {
      let offset = 0
      return {
        setStart: () => {},
        setEnd: (_node: Node, end: number) => {
          offset = end
        },
        getBoundingClientRect: () => ({ width: offset === 2 ? 25 : 100 }),
      } as unknown as Range
    })
    try {
      const binding = bindLyricSweep(elements, [word!, word!])
      binding.write(0, 1.4)
      binding.write(1, 1.4)
      const before = elements[0]!.style.getPropertyValue('--lyric-sweep-position')
      expect(binding.refresh()).toBe(false)
      expect(range).toHaveBeenCalledTimes(2)
      width = 200
      expect(binding.refresh()).toBe(true)
      expect(range).toHaveBeenCalledTimes(3)
      expect(elements[0]!.style.getPropertyValue('--lyric-sweep-position')).not.toBe(before)
      const paused = elements[0]!.style.getPropertyValue('--lyric-sweep-position')
      expect(binding.write(0, 1.4)).toBeCloseTo(0.25)
      expect(elements[0]!.style.getPropertyValue('--lyric-sweep-position')).toBe(paused)
      expect(elements[1]!.style.getPropertyValue('--lyric-sweep-position')).toBe(before)
      expect(binding.refresh()).toBe(false)
      expect(range).toHaveBeenCalledTimes(3)
      binding.clear()
    } finally {
      elements.forEach((element) => element.remove())
      range.mockRestore()
    }
  })
})
