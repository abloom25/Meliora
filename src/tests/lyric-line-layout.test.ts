import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLyricLineMeasurer } from '../platform/web/lyric-line-layout'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function fixture() {
  const words = ['one', 'two', 'three', 'four'].map((text) => ({
    text,
    time: 0,
    duration: 1,
    trailingSpace: true,
  }))
  const elements = words.map((word) => {
    const element = document.createElement('span')
    element.textContent = word.text
    element.style.cssText = 'display:inline-block;font-size:20px;line-height:24px;width:40px'
    document.body.append(element)
    return element
  })
  return { words, elements, measurer: createLyricLineMeasurer() }
}

describe('cached lyric line geometry', () => {
  it('avoids word reads and space probes on repeat and unconstrained width changes', () => {
    const { words, elements, measurer } = fixture()
    const style = vi.spyOn(window, 'getComputedStyle')
    const probe = vi.spyOn(document.body, 'append')
    const initial = measurer.measure(elements, words, 150)
    expect(initial).toEqual([2])
    expect(probe).toHaveBeenCalledTimes(1)
    style.mockClear()
    for (let pass = 0; pass < 50; pass++)
      expect(measurer.measure(elements, words, 150)).toBe(initial)
    expect(style).toHaveBeenCalledTimes(50)
    expect(measurer.measure(elements, words, 220)).toEqual([])
    expect(style).toHaveBeenCalledTimes(51)
    expect(probe).toHaveBeenCalledTimes(1)
    style.mockClear()
    for (let pass = 0; pass < 50; pass++) createLyricLineMeasurer().measure(elements, words, 150)
    expect(style).toHaveBeenCalledTimes(250)
  })

  it('invalidates after fonts or source nodes change, including late font loads at the same size', () => {
    const { words, elements, measurer } = fixture()
    const first = measurer.measure(elements, words, 150)
    for (const element of elements) element.style.cssText += ';font-size:30px;width:60px'
    expect(measurer.measure(elements, words, 150)).not.toBe(first)
    const style = vi.spyOn(window, 'getComputedStyle')
    measurer.invalidate()
    measurer.measure(elements, words, 150)
    expect(style.mock.calls.length).toBeGreaterThan(1)
    const replacement = elements[1]!.cloneNode(true) as HTMLElement
    elements[1]!.replaceWith(replacement)
    elements[1] = replacement
    style.mockClear()
    measurer.measure(elements, words, 150)
    expect(style.mock.calls.length).toBeGreaterThan(1)
  })

  it('remeasures constrained words when a wider container allows them to unwrap', () => {
    const { words, elements, measurer } = fixture()
    elements[0]!.style.width = '100px'
    measurer.measure(elements, words, 100)
    elements[0]!.style.width = '180px'
    const style = vi.spyOn(window, 'getComputedStyle')
    measurer.measure(elements, words, 200)
    expect(style).toHaveBeenCalledTimes(1)
    const breaks = measurer.measure(elements, words, 200)
    expect(breaks[0]).toBe(1)
  })
})
