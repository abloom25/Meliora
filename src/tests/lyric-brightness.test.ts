import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLyricBrightness } from '../platform/web/lyric-brightness'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fixture() {
  const line = document.createElement('div')
  line.innerHTML =
    '<div class="lyric-original" data-v-test><span id="word" class="lyric-word emphasized unbroken" data-lyric-sweep style="--lyric-word-fill: .5"><span class="lyric-char" style="--lyric-char-emphasis: 1">Oh</span></span><span class="lyric-gap"> </span><br><span class="lyric-word">yeah</span></div><div class="lyric-translation">翻译</div>'
  document.body.append(line)
  return line
}

describe('lyric brightness layers', () => {
  it('keeps the resting copy out of source queries, accessibility and live sweep styles', () => {
    const line = fixture()
    const layer = createLyricBrightness(line)!
    const copy = line.querySelector<HTMLElement>('.lyric-original-dim')!
    expect(copy.textContent).toBe(layer.original.textContent)
    expect(copy.getAttribute('aria-hidden')).toBe('true')
    expect(copy.inert).toBe(true)
    expect(copy.hasAttribute('data-v-test')).toBe(true)
    expect(copy.querySelectorAll('br')).toHaveLength(1)
    expect(copy.querySelector('.lyric-dim-word.emphasized.unbroken')).not.toBeNull()
    expect(
      copy.querySelector('.lyric-word, .lyric-char, .lyric-gap, [style], [id], [data-lyric-sweep]'),
    ).toBeNull()
    expect(line.querySelectorAll('.lyric-word')).toHaveLength(2)
    expect(line.querySelectorAll('.lyric-translation')).toHaveLength(1)
    layer.setActive(true)
    expect(line.hasAttribute('data-lyric-bright')).toBe(true)
    layer.setActive(false)
    expect(line.hasAttribute('data-lyric-bright')).toBe(false)
    layer.dispose()
    expect(copy.isConnected).toBe(false)
    expect(line.hasAttribute('data-lyric-layered')).toBe(false)
  })

  it('only rebuilds after content or line breaks change, never on animation style writes', () => {
    const line = fixture()
    const layer = createLyricBrightness(line)!
    const copy = line.querySelector('.lyric-original-dim')!
    layer.original.firstElementChild!.setAttribute('style', '--lyric-word-fill: .8')
    layer.sync()
    expect(line.querySelector('.lyric-original-dim')).toBe(copy)
    layer.original.querySelector('br')!.remove()
    layer.original.lastElementChild!.textContent = 'new'
    layer.sync()
    expect(line.querySelector('.lyric-original-dim')).not.toBe(copy)
    expect(line.querySelector('.lyric-original-dim br')).toBeNull()
    expect(line.querySelector('.lyric-original-dim')!.textContent).toBe('Oh new')
    layer.dispose()
    layer.original.append('after disposal')
    layer.sync()
    expect(line.querySelector('.lyric-original-dim')).toBeNull()
  })

  it('cancels cold entrance effects on exit and leaves harmony opacity to its spring', () => {
    const cancel = vi.fn()
    const animate = vi.fn(() => ({ cancel, onfinish: null }) as unknown as Animation)
    const line = fixture()
    const layer = createLyricBrightness(line)!
    layer.original.animate = animate
    line.querySelector<HTMLElement>('.lyric-original-dim')!.animate = animate
    layer.setActive(true)
    expect(animate).toHaveBeenCalledTimes(2)
    layer.setActive(false)
    expect(cancel).toHaveBeenCalledTimes(2)
    layer.setActive(true)
    expect(animate).toHaveBeenCalledTimes(2)
    layer.dispose()
    line.classList.add('background')
    const harmony = createLyricBrightness(line)!
    harmony.setActive(true)
    expect(animate).toHaveBeenCalledTimes(2)
    harmony.dispose()
  })
})
