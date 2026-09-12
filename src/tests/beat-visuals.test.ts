import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBeatVisualRenderer } from '../utils/beat-visuals'

describe('beat visual renderer', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('updates newly mounted secondary targets even when the sample is unchanged', () => {
    const first = document.createElement('div')
    const second = document.createElement('div')
    const nodes = [first]
    document.body.append(first)
    const firstWrite = vi.spyOn(first.style, 'setProperty')
    const renderer = createBeatVisualRenderer({ getBeatTargets: () => nodes })
    renderer.renderBeat(0.4, 0.2)
    renderer.renderBeat(0.4, 0.2)
    expect(firstWrite).toHaveBeenCalledTimes(2)
    nodes.push(second)
    document.body.append(second)
    renderer.renderBeat(0.4, 0.2)
    expect(firstWrite).toHaveBeenCalledTimes(2)
    expect(second.style.getPropertyValue('--beat-level')).toBe('0.400')
    expect(second.style.getPropertyValue('--beat-sustain')).toBe('0.200')
  })

  it('skips detached nodes and restores values after remounting', () => {
    const node = document.createElement('div')
    const renderer = createBeatVisualRenderer({ getBeatTargets: () => [null, node] })
    document.body.append(node)
    renderer.renderBeat(0.5, 0.1)
    node.remove()
    node.style.removeProperty('--beat-level')
    renderer.renderBeat(0.5, 0.1)
    expect(node.style.getPropertyValue('--beat-level')).toBe('')
    document.body.append(node)
    renderer.renderBeat(0.5, 0.1)
    expect(node.style.getPropertyValue('--beat-level')).toBe('0.500')
  })

  it('clamps spectrum levels, deduplicates writes and handles new targets', () => {
    const first = document.createElement('div')
    const second = document.createElement('div')
    const nodes = [first]
    document.body.append(first)
    const write = vi.spyOn(first.style, 'setProperty')
    const renderer = createBeatVisualRenderer({ getSpectrumTargets: () => nodes })
    renderer.renderSpectrum([-1, 0.5, 2])
    renderer.renderSpectrum([-1, 0.5, 2])
    expect(write).toHaveBeenCalledTimes(3)
    nodes.push(second)
    document.body.append(second)
    renderer.renderSpectrum([-1, 0.5, 2])
    expect(second.style.getPropertyValue('--spectrum-level-0')).toBe('8.0%')
    expect(second.style.getPropertyValue('--spectrum-level-1')).toBe('50.0%')
    expect(second.style.getPropertyValue('--spectrum-level-2')).toBe('100.0%')
    renderer.renderSpectrum([0, 0, 0])
    expect(first.style.getPropertyValue('--spectrum-level-1')).toBe('8.0%')
  })
})
