import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import {
  useLyricsEngine,
  type LyricsEngineOptions,
  type LyricsSceneInput,
} from '../composables/useLyricsEngine'
import { VirtualLyricLayout } from '../core/lyrics/virtual-layout'

// 视口 600px,锚点在 42% 处 = 252;行高 40、行距 30,行距 70 一行
const VIEWPORT = 600
const LINE = 40
const GAP = 30
const HARMONY = 24
const HARMONY_GAP = 8
const PITCH = LINE + GAP
const ANCHOR_Y = VIEWPORT * 0.42 - LINE / 2

let rafCallbacks: FrameRequestCallback[] = []

function installAnimationFrameMock() {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    rafCallbacks.push(callback)
    return rafCallbacks.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => {
    rafCallbacks[handle - 1] = () => {}
  })
}

function runFrames(count: number, stepMs = 16) {
  for (let frame = 0; frame < count; frame += 1) {
    vi.advanceTimersByTime(stepMs)
    const callbacks = rafCallbacks
    rafCallbacks = []
    callbacks.forEach((callback) => callback(performance.now()))
  }
}

function defineReadonlyNumber(target: object, key: string, value: number) {
  Object.defineProperty(target, key, { configurable: true, get: () => value })
}

interface Harness {
  wrapper: VueWrapper
  engine: ReturnType<typeof useLyricsEngine>
  lines: HTMLElement[]
  viewport: HTMLElement
  animated: { value: boolean }
  spring: { value: number }
  debugEnabled: { value: boolean }
}

function createHarness(
  count: number,
  background: boolean[] = [],
  virtualOptions: Pick<
    LyricsEngineOptions,
    'getLineCount' | 'getEstimatedHeight' | 'onWindowChange' | 'getWaitingElement'
  > = {},
): Harness {
  const lines: HTMLElement[] = []
  let viewport: HTMLElement | undefined
  const animated = { value: true }
  const spring = { value: 1 }
  const debugEnabled = { value: false }
  let engine!: ReturnType<typeof useLyricsEngine>

  const wrapper = mount(
    defineComponent({
      setup() {
        engine = useLyricsEngine({
          getViewport: () => viewport,
          getLineElements: () => lines,
          isAnimated: () => animated.value,
          getSpringScale: () => spring.value,
          getGaps: () => ({ gap: GAP, harmonyGap: HARMONY_GAP }),
          debugEnabled: () => debugEnabled.value,
          ...virtualOptions,
        })
        return () =>
          h(
            'div',
            {
              ref: (element) => {
                viewport = element as HTMLElement
              },
            },
            Array.from({ length: count }, (_, index) =>
              h('button', {
                'data-lyric-index': index,
                ref: (element) => {
                  if (element) lines[index] = element as HTMLElement
                },
              }),
            ),
          )
      },
    }),
    { attachTo: document.body },
  )

  defineReadonlyNumber(viewport!, 'clientHeight', VIEWPORT)
  for (const [index, line] of lines.entries()) {
    defineReadonlyNumber(line, 'offsetHeight', background[index] ? HARMONY : LINE)
  }
  return { wrapper, engine, lines, viewport: viewport!, animated, spring, debugEnabled }
}

function sceneFor(count: number, focus: number, open: number[] = [], background: boolean[] = []) {
  const scene: LyricsSceneInput = {
    background: Array.from({ length: count }, (_, index) => background[index] ?? false),
    open: Array.from({ length: count }, (_, index) => open.includes(index)),
    focus,
  }
  return scene
}

function lineY(line: HTMLElement): number {
  return Number.parseFloat(line.style.translate.replace(/^0\s+/, '')) || 0
}

function lineScale(line: HTMLElement): number {
  return Number.parseFloat(line.style.getPropertyValue('--lyric-line-scale'))
}

function createWaitingElement(anchor: number): HTMLElement {
  const element = document.createElement('div')
  element.dataset.waitingAnchor = String(anchor)
  element.style.visibility = 'hidden'
  document.body.append(element)
  return element
}

/** 舞台内(仍在写位置)的行,自上而下 */
function onstage(lines: HTMLElement[]): HTMLElement[] {
  return lines.filter((line) => line.style.visibility !== 'hidden')
}

function expectNoCrossing(lines: HTMLElement[], minPitch: number) {
  const ys = onstage(lines).map(lineY)
  for (let index = 1; index < ys.length; index += 1) {
    expect(ys[index]! - ys[index - 1]!).toBeGreaterThanOrEqual(minPitch - 0.01)
  }
}

describe('useLyricsEngine', () => {
  it('updates only changed offscreen harmony extents during long-lyric scenes and reverse seeks', () => {
    const viewport = document.createElement('div')
    defineReadonlyNumber(viewport, 'clientHeight', VIEWPORT)
    const rows = Array.from({ length: 8 }, (_, index) => {
      const row = document.createElement('button')
      row.dataset.lyricIndex = String(index)
      defineReadonlyNumber(row, 'offsetHeight', LINE)
      viewport.append(row)
      return row
    })
    const count = 20000
    const background = Array.from({ length: count }, (_, index) => index === 1000 || index === 1500)
    const engine = useLyricsEngine({
      getViewport: () => viewport,
      getLineElements: () => rows,
      getLineCount: () => count,
      getEstimatedHeight: () => LINE,
      isAnimated: () => false,
      getSpringScale: () => 1,
      getGaps: () => ({ gap: GAP, harmonyGap: HARMONY_GAP }),
    })
    engine.setScene({ background, openHarmonies: [1000], focus: 0 }, 'none')
    const writes = vi.spyOn(VirtualLyricLayout.prototype, 'set')
    engine.setScene({ background, openHarmonies: [1500], focus: 1 }, 'none')
    expect(writes.mock.calls.map(([index]) => index)).toEqual([1000, 1500])
    writes.mockClear()
    engine.setScene({ background, openHarmonies: [1500], focus: 2 }, 'none')
    expect(writes).not.toHaveBeenCalled()
    engine.setScene({ background, openHarmonies: [1000], focus: 0 }, 'none')
    expect(writes.mock.calls.map(([index]) => index)).toEqual([1500, 1000])
    engine.reset()
  })

  beforeEach(() => {
    vi.useFakeTimers()
    rafCallbacks = []
    installAnimationFrameMock()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('places the focused line at the anchor and stacks the rest by pitch', () => {
    const { engine, lines, wrapper } = createHarness(6)
    engine.setScene(sceneFor(6, 2), 'none', { follow: true })

    expect(lineY(lines[2]!)).toBeCloseTo(ANCHOR_Y, 5)
    expect(lineY(lines[3]!)).toBeCloseTo(ANCHOR_Y + PITCH, 5)
    expect(lineY(lines[0]!)).toBeCloseTo(ANCHOR_Y - 2 * PITCH, 5)
    wrapper.unmount()
  })

  it.each([140, 600, 1000])(
    'reserves room on both sides of the waiting indicator at a %i px viewport',
    (height) => {
      const { engine, lines, viewport, wrapper } = createHarness(12)
      defineReadonlyNumber(viewport, 'clientHeight', height)
      engine.setScene({ ...sceneFor(12, 4), waiting: { nextAnchor: 5 }, active: [] }, 'none', {
        follow: true,
      })
      const dotCenter = height * 0.42
      expect(lineY(lines[4]!) + LINE).toBeLessThan(dotCenter - 20)
      expect(lineY(lines[5]!)).toBeGreaterThan(dotCenter + 20)
      expect(lineY(lines[5]!) - lineY(lines[4]!) - LINE).toBeGreaterThan(GAP + 40)
      expectNoCrossing(lines, LINE)
      wrapper.unmount()
    },
  )

  it('puts an intro wait before the first lyric and does not jump when browsing starts there', () => {
    const { engine, lines, wrapper } = createHarness(12)
    engine.setScene({ ...sceneFor(12, -1), waiting: { nextAnchor: 0 }, active: [] }, 'none', {
      follow: true,
    })
    const before = lineY(lines[0]!)
    expect(before).toBeGreaterThan(VIEWPORT * 0.42 + 20)
    engine.browseBy(0, { snap: true })
    expect(lineY(lines[0]!)).toBe(before)
    wrapper.unmount()
  })

  it('opens and removes the waiting gap from current positions without a cascade or snap', () => {
    const { engine, lines, wrapper } = createHarness(12)
    engine.setScene(sceneFor(12, 4), 'none', { follow: true })
    const indices = [3, 4, 5, 6]
    const before = indices.map((index) => lineY(lines[index]!))
    engine.setScene({ ...sceneFor(12, 4), waiting: { nextAnchor: 5 }, active: [] }, 'spring', {
      follow: true,
    })
    expect(indices.map((index) => lineY(lines[index]!))).toEqual(before)
    runFrames(1)
    expect(lineY(lines[4]!)).toBeLessThan(before[1]! - 0.1)
    runFrames(120)
    expect(lineY(lines[4]!) + LINE).toBeLessThan(VIEWPORT * 0.42 - 20)
    expect(lineY(lines[5]!)).toBeGreaterThan(VIEWPORT * 0.42 + 20)

    const waitingPositions = indices.map((index) => lineY(lines[index]!))
    engine.setScene(sceneFor(12, 5), 'spring', { follow: true })
    expect(indices.map((index) => lineY(lines[index]!))).toEqual(waitingPositions)
    runFrames(1)
    expect(lineY(lines[5]!)).toBeLessThan(waitingPositions[2]! - 0.1)
    runFrames(120)
    expect(lineY(lines[5]!)).toBeCloseTo(ANCHOR_Y, 2)
    expect(lineY(lines[5]!) - lineY(lines[4]!)).toBeCloseTo(PITCH, 2)
    expect(rafCallbacks).toHaveLength(0)
    wrapper.unmount()
  })

  it('keeps the visible reading anchor when a waiting gap changes above a browsed passage', () => {
    const { engine, lines, wrapper } = createHarness(20)
    engine.setScene(sceneFor(20, 4), 'none', { follow: true })
    engine.browseBy(320, { snap: true })
    const indices = [5, 6, 7, 8]
    const before = indices.map((index) => lineY(lines[index]!))
    engine.setScene({ ...sceneFor(20, 4), waiting: { nextAnchor: 5 }, active: [] }, 'spring')
    runFrames(120)
    expect(engine.isBrowsing()).toBe(true)
    expect(indices.map((index) => lineY(lines[index]!))).toEqual(before)
    engine.setScene(sceneFor(20, 5), 'spring')
    runFrames(120)
    expect(indices.map((index) => lineY(lines[index]!))).toEqual(before)
    wrapper.unmount()
  })

  it('keeps distant virtual waiting lyrics mounted and below the indicator', () => {
    const onWindowChange = vi.fn()
    const { engine, lines, wrapper } = createHarness(16, [], {
      getLineCount: () => 2000,
      getEstimatedHeight: () => LINE,
      onWindowChange,
    })
    lines.forEach((line, slot) => {
      line.dataset.lyricIndex = String(990 + slot)
    })
    engine.setScene({ ...sceneFor(2000, 999), waiting: { nextAnchor: 1000 }, active: [] }, 'none', {
      follow: true,
    })
    expect(lineY(lines[9]!) + LINE).toBeLessThan(VIEWPORT * 0.42 - 20)
    expect(lineY(lines[10]!)).toBeGreaterThan(VIEWPORT * 0.42 + 20)
    const window = onWindowChange.mock.lastCall?.[0] as number[]
    expect(window).toContain(1000)
    expect(window.length).toBeLessThan(100)
    wrapper.unmount()
  })

  it('keeps harmony expansion separate from the reserved waiting gap', () => {
    const background = [false, false, false, false, false, true, false, false]
    const { engine, lines, wrapper } = createHarness(8, background)
    engine.setScene(
      { ...sceneFor(8, 4, [5], background), waiting: { nextAnchor: 6 }, active: [] },
      'none',
      { follow: true },
    )
    expect(lineY(lines[5]!) + HARMONY).toBeLessThan(VIEWPORT * 0.42 - 20)
    const nextY = lineY(lines[6]!)
    expect(nextY).toBeGreaterThan(VIEWPORT * 0.42 + 20)
    engine.setScene(
      { ...sceneFor(8, 4, [], background), waiting: { nextAnchor: 6 }, active: [] },
      'spring',
      { follow: true },
    )
    for (let frame = 0; frame < 90; frame += 1) {
      runFrames(1)
      expect(lineY(lines[6]!)).toBeCloseTo(nextY, 2)
    }
    expect(lines[5]!.style.getPropertyValue('--lyric-harmony')).toBe('0.000')
    expect(lineY(lines[4]!) + LINE).toBeLessThan(VIEWPORT * 0.42 - 20)
    wrapper.unmount()
  })

  it('reflows waiting space to a smaller viewport while preserving the current visual position', () => {
    const { engine, lines, viewport, wrapper } = createHarness(12)
    engine.setScene({ ...sceneFor(12, 4), waiting: { nextAnchor: 5 }, active: [] }, 'none', {
      follow: true,
    })
    const before = lineY(lines[5]!)
    defineReadonlyNumber(viewport, 'clientHeight', 200)
    engine.remeasure(true, { transition: 'reflow' })
    expect(lineY(lines[5]!)).toBe(before)
    runFrames(120)
    expect(lineY(lines[4]!) + LINE).toBeLessThan(200 * 0.42 - 20)
    expect(lineY(lines[5]!)).toBeGreaterThan(200 * 0.42 + 20)
    expect(lineY(lines[5]!)).toBeLessThan(200)
    wrapper.unmount()
  })

  it('applies the usual bounded seek to a distant waiting gap', () => {
    const { engine, lines, wrapper } = createHarness(80)
    engine.setScene(sceneFor(80, 2), 'none', { follow: true })
    engine.setScene({ ...sceneFor(80, 59), waiting: { nextAnchor: 60 }, active: [] }, 'seek', {
      follow: true,
    })
    expect(lineY(lines[60]!) - engine.targets()[60]!).toBeCloseTo(VIEWPORT * 0.55, 2)
    const before = lineY(lines[60]!)
    runFrames(1)
    expect(lineY(lines[60]!)).toBeLessThan(before - 0.1)
    runFrames(120)
    expect(lineY(lines[59]!) + LINE).toBeLessThan(VIEWPORT * 0.42 - 20)
    expect(lineY(lines[60]!)).toBeGreaterThan(VIEWPORT * 0.42 + 20)
    expectNoCrossing(lines, LINE)
    wrapper.unmount()
  })

  it('keeps waiting coordinates stable when virtual row heights are measured later', () => {
    const { engine, lines, wrapper } = createHarness(12)
    engine.setScene({ ...sceneFor(12, 4), waiting: { nextAnchor: 5 }, active: [] }, 'none', {
      follow: true,
    })
    const indices = [3, 4, 5, 6]
    const before = indices.map((index) => lineY(lines[index]!))
    defineReadonlyNumber(lines[0]!, 'offsetHeight', 80)
    defineReadonlyNumber(lines[5]!, 'offsetHeight', 90)
    engine.syncMounted()
    expect(indices.map((index) => lineY(lines[index]!))).toEqual(before)
    runFrames(120)
    expect(lineY(lines[5]!)).toBeCloseTo(before[2]!, 2)
    expect(lineY(lines[6]!)).toBeCloseTo(lineY(lines[5]!) + 90 + GAP, 2)
    expect(lineY(lines[4]!) + LINE).toBeLessThan(VIEWPORT * 0.42 - 20)
    wrapper.unmount()
  })

  it.each([
    [2, 60],
    [60, 2],
  ])('moves the waiting marker with its next row during a seek from %i to %i', (from, next) => {
    const marker = createWaitingElement(next)
    const { engine, lines, wrapper } = createHarness(80, [], {
      getWaitingElement: () => marker,
    })
    engine.setScene(sceneFor(80, from), 'none', { follow: true })
    engine.setScene(
      { ...sceneFor(80, next - 1), waiting: { nextAnchor: next }, active: [] },
      'seek',
      { follow: true },
    )
    const center = () => Number.parseFloat(marker.style.top)
    expect(marker.style.visibility).toBe('visible')
    expect(Math.abs(center() - VIEWPORT * 0.42)).toBeCloseTo(VIEWPORT * 0.55, 2)
    const start = center()
    for (let frame = 0; frame < 120; frame += 1) {
      expect(lineY(lines[next]!) - center()).toBeCloseTo(48, 2)
      runFrames(1)
      if (frame === 0) expect(Math.abs(center() - start)).toBeGreaterThan(0.1)
    }
    expect(center()).toBeCloseTo(VIEWPORT * 0.42, 2)
    expect(rafCallbacks).toHaveLength(0)
    wrapper.unmount()
  })

  it('positions a newly mounted waiting marker before revealing it without starting another loop', () => {
    let marker: HTMLElement | null = null
    const { engine, lines, wrapper } = createHarness(12, [], {
      getWaitingElement: () => marker,
    })
    engine.setScene(sceneFor(12, 3), 'none', { follow: true })
    engine.setScene({ ...sceneFor(12, 4), waiting: { nextAnchor: 5 } }, 'seek', { follow: true })
    runFrames(8)
    marker = createWaitingElement(5)
    const requests = vi.mocked(window.requestAnimationFrame).mock.calls.length
    engine.syncWaiting()
    expect(marker.style.visibility).toBe('visible')
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(lineY(lines[5]!) - 48, 2)
    expect(vi.mocked(window.requestAnimationFrame).mock.calls).toHaveLength(requests)
    const oldMarker = marker
    marker = createWaitingElement(5)
    engine.syncWaiting()
    expect(marker.style.top).toBe(oldMarker.style.top)
    expect(marker.style.visibility).toBe('visible')
    wrapper.unmount()
  })

  it('preserves an outgoing waiting marker while a different interval is patched into the DOM', () => {
    let marker = createWaitingElement(5)
    const { engine, lines, wrapper } = createHarness(20, [], {
      getWaitingElement: () => marker,
    })
    engine.setScene({ ...sceneFor(20, 4), waiting: { nextAnchor: 5 } }, 'none', { follow: true })
    const leavingMarker = marker
    const before = leavingMarker.style.top
    engine.setScene({ ...sceneFor(20, 11), waiting: { nextAnchor: 12 } }, 'seek', { follow: true })
    runFrames(3)
    expect(leavingMarker.style.top).toBe(before)
    expect(leavingMarker.style.visibility).toBe('visible')
    marker = createWaitingElement(12)
    engine.syncWaiting()
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(lineY(lines[12]!) - 48, 2)
    expect(marker.style.visibility).toBe('visible')
    const exitTop = marker.style.top
    engine.setScene(sceneFor(20, 12), 'spring', { follow: true })
    runFrames(3)
    expect(marker.style.top).toBe(exitTop)
    expect(marker.style.visibility).toBe('visible')
    engine.reset()
    expect(marker.style.visibility).toBe('hidden')
    wrapper.unmount()
  })

  it('hides waiting markers until both their anchor row and viewport are measurable and connected', () => {
    const marker = createWaitingElement(5)
    const { engine, lines, viewport, wrapper } = createHarness(12, [], {
      getWaitingElement: () => marker,
    })
    defineReadonlyNumber(viewport, 'clientHeight', 0)
    engine.setScene({ ...sceneFor(12, 4), waiting: { nextAnchor: 5 } }, 'none', { follow: true })
    engine.syncWaiting()
    expect(marker.style.visibility).toBe('hidden')
    defineReadonlyNumber(viewport, 'clientHeight', VIEWPORT)
    engine.remeasure()
    expect(marker.style.visibility).toBe('visible')
    lines[5]!.remove()
    engine.syncWaiting()
    expect(marker.style.visibility).toBe('hidden')
    viewport.append(lines[5]!)
    engine.syncMounted()
    expect(marker.style.visibility).toBe('visible')
    defineReadonlyNumber(viewport, 'clientHeight', 0)
    engine.remeasure()
    engine.syncWaiting()
    expect(marker.style.visibility).toBe('hidden')
    wrapper.unmount()
  })

  it('reflows the waiting marker continuously when the viewport changes its reserved spacing', () => {
    const marker = createWaitingElement(5)
    const { engine, lines, viewport, wrapper } = createHarness(12, [], {
      getWaitingElement: () => marker,
    })
    defineReadonlyNumber(viewport, 'clientHeight', 1000)
    engine.setScene({ ...sceneFor(12, 4), waiting: { nextAnchor: 5 } }, 'none', { follow: true })
    const start = Number.parseFloat(marker.style.top)
    expect(lineY(lines[5]!) - start).toBe(50)
    defineReadonlyNumber(viewport, 'clientHeight', 200)
    engine.remeasure(true, { transition: 'reflow' })
    expect(Number.parseFloat(marker.style.top)).toBe(start)
    runFrames(1, 0)
    expect(Number.parseFloat(marker.style.top)).toBe(start)
    runFrames(1)
    expect(Number.parseFloat(marker.style.top)).toBeLessThan(start)
    expect(Number.parseFloat(marker.style.top)).toBeGreaterThan(start - 20)
    // 缩窗后下一句暂时在舞台外；等它重新进场，DOM 才会恢复写入真实 Y。
    runFrames(10)
    expect(lineY(lines[5]!) - Number.parseFloat(marker.style.top)).toBeGreaterThan(30)
    expect(lineY(lines[5]!) - Number.parseFloat(marker.style.top)).toBeLessThan(50)
    runFrames(120)
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(200 * 0.42, 2)
    expect(lineY(lines[5]!) - Number.parseFloat(marker.style.top)).toBeCloseTo(30, 2)
    expect(rafCallbacks).toHaveLength(0)
    wrapper.unmount()
  })

  it('reveals the waiting marker only after its virtual anchor row joins the measured window', () => {
    const marker = createWaitingElement(500)
    const { engine, lines, viewport, wrapper } = createHarness(1, [], {
      getLineCount: () => 1000,
      getEstimatedHeight: () => LINE,
      getWaitingElement: () => marker,
    })
    engine.setScene({ ...sceneFor(1000, 499), waiting: { nextAnchor: 500 } }, 'none', {
      follow: true,
    })
    expect(marker.style.visibility).toBe('hidden')
    const nextRow = document.createElement('button')
    nextRow.dataset.lyricIndex = '500'
    defineReadonlyNumber(nextRow, 'offsetHeight', LINE)
    viewport.append(nextRow)
    lines.push(nextRow)
    engine.syncMounted()
    expect(marker.style.visibility).toBe('visible')
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(VIEWPORT * 0.42, 2)
    expect(lineY(nextRow) - Number.parseFloat(marker.style.top)).toBeCloseTo(48, 2)
    wrapper.unmount()
  })

  it('keeps the waiting marker synchronized through direct dragging, cancel and disabled animation', () => {
    const marker = createWaitingElement(5)
    const { engine, lines, animated, viewport, wrapper } = createHarness(12, [], {
      getWaitingElement: () => marker,
    })
    const waiting = { ...sceneFor(12, 4), waiting: { nextAnchor: 5 } }
    engine.setScene(waiting, 'none', { follow: true })
    engine.browseBy(37, { snap: true })
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(VIEWPORT * 0.42 - 37, 2)
    engine.follow('seek')
    runFrames(2)
    engine.cancel()
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(VIEWPORT * 0.42, 2)
    animated.value = false
    defineReadonlyNumber(viewport, 'clientHeight', 200)
    engine.remeasure(true, { transition: 'reflow' })
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(200 * 0.42, 2)
    expect(lineY(lines[5]!) - Number.parseFloat(marker.style.top)).toBeCloseTo(30, 2)
    wrapper.unmount()
  })

  it('scales inactive main lines independently while leaving active and harmony lines full size', () => {
    const background = [false, true, false, false]
    const { engine, lines, wrapper } = createHarness(4, background)
    engine.setScene({ ...sceneFor(4, 2, [1], background), active: [2], playing: true }, 'none', {
      follow: true,
    })
    expect(lines.map(lineScale)).toEqual([0.97, 1, 1, 0.97])
    wrapper.unmount()
  })

  it('starts each changed main-line scale with its positional wave and settles both springs', () => {
    const { engine, lines, wrapper } = createHarness(20)
    engine.setScene(sceneFor(20, 6), 'none', { follow: true })
    const beforeY = lines.map(lineY)
    const beforeScale = lines.map(lineScale)
    engine.setScene(sceneFor(20, 7), 'spring', { follow: true })
    const positionStart = new Map<number, number>()
    const scaleStart = new Map<number, number>()
    for (let elapsed = 4; elapsed <= 200; elapsed += 4) {
      runFrames(1, 4)
      for (const index of [6, 7]) {
        if (!positionStart.has(index) && Math.abs(lineY(lines[index]!) - beforeY[index]!) > 0.01)
          positionStart.set(index, elapsed)
        if (
          !scaleStart.has(index) &&
          Math.abs(lineScale(lines[index]!) - beforeScale[index]!) > 0.000001
        )
          scaleStart.set(index, elapsed)
      }
    }
    expect(scaleStart).toEqual(positionStart)
    expect(scaleStart.size).toBe(2)
    runFrames(90)
    expect(lineScale(lines[6]!)).toBe(0.97)
    expect(lineScale(lines[7]!)).toBe(1)
    expect(rafCallbacks).toHaveLength(0)
    wrapper.unmount()
  })

  it('keeps scale position and velocity when an in-flight line changes active state again', () => {
    const { engine, lines, wrapper } = createHarness(20)
    engine.setScene(sceneFor(20, 2), 'none', { follow: true })
    engine.setScene(sceneFor(20, 3), 'spring', { follow: true })
    runFrames(12)
    const midway = lineScale(lines[3]!)
    expect(midway).toBeGreaterThan(0.97)
    expect(midway).toBeLessThan(1)
    engine.setScene(sceneFor(20, 2), 'spring', { follow: true })
    expect(lineScale(lines[3]!)).toBe(midway)
    runFrames(1)
    // 目标反向后还会短暂沿原速度继续放大，不能重建成零速度 CSS 补间。
    expect(lineScale(lines[3]!)).toBeGreaterThan(midway)
    runFrames(90)
    expect(lineScale(lines[3]!)).toBe(0.97)
    wrapper.unmount()
  })

  it('does not hold an already moving scale when playback resumes on a new line', () => {
    const { engine, lines, wrapper } = createHarness(20)
    engine.setScene(sceneFor(20, 2), 'none', { follow: true })
    engine.setScene({ ...sceneFor(20, 2), playing: false }, 'spring')
    runFrames(4)
    const growing = lineScale(lines[3]!)
    expect(growing).toBeGreaterThan(0.97)
    engine.setScene({ ...sceneFor(20, 3), playing: true }, 'spring', { follow: true })
    expect(lineScale(lines[3]!)).toBe(growing)
    runFrames(1)
    expect(lineScale(lines[3]!)).toBeGreaterThan(growing)
    wrapper.unmount()
  })

  it('keeps a visible positional cascade even while resumed playback is already scaling every row', () => {
    const { engine, lines, wrapper } = createHarness(20)
    engine.setScene({ ...sceneFor(20, 6), playing: false }, 'none', { follow: true })
    engine.setScene({ ...sceneFor(20, 6), playing: true }, 'spring', { follow: true })
    runFrames(6)
    const indices = [5, 6, 7, 8, 9]
    const before = lines.map(lineY)
    const shrinking = lineScale(lines[5]!)
    engine.setScene(sceneFor(20, 7), 'spring', { follow: true, budgetMs: 2000 })
    runFrames(1, 2)
    // scale 继续保留速度，但不能因此把尚未开始的 Y 牵引整片豁免。
    expect(lineScale(lines[5]!)).toBeLessThan(shrinking)
    expect(lineY(lines[5]!)).toBe(before[5])
    const startedAt = new Map<number, number>()
    for (let elapsed = 4; elapsed <= 440; elapsed += 2) {
      runFrames(1, 2)
      for (const index of indices) {
        if (!startedAt.has(index) && before[index]! - lineY(lines[index]!) > 0.01)
          startedAt.set(index, elapsed)
      }
      expectNoCrossing(lines, LINE)
    }
    expect(startedAt.size).toBe(indices.length)
    for (let slot = 1; slot < indices.length; slot += 1) {
      expect(
        startedAt.get(indices[slot]!)! - startedAt.get(indices[slot - 1]!)!,
      ).toBeGreaterThanOrEqual(36)
    }
    wrapper.unmount()
  })

  it('restores full-size main lines while paused or browsing, and resumes emphasis on follow', () => {
    const { engine, lines, wrapper } = createHarness(12)
    engine.setScene(sceneFor(12, 2), 'none', { follow: true })
    engine.setScene({ ...sceneFor(12, 2), playing: false }, 'spring')
    runFrames(90)
    expect(lines.slice(0, 8).map(lineScale)).toEqual(Array(8).fill(1))
    engine.setScene({ ...sceneFor(12, 2), playing: true }, 'spring')
    runFrames(90)
    expect(lineScale(lines[1]!)).toBe(0.97)
    engine.browseBy(40)
    runFrames(90)
    expect(lines.slice(0, 8).map(lineScale)).toEqual(Array(8).fill(1))
    engine.follow('spring')
    runFrames(90)
    expect(lineScale(lines[1]!)).toBe(0.97)
    expect(lineScale(lines[2]!)).toBe(1)
    wrapper.unmount()
  })

  it('snaps scale emphasis with animations disabled and keeps touch positions one-to-one', () => {
    const { engine, lines, animated, wrapper } = createHarness(12)
    engine.setScene(sceneFor(12, 2), 'none', { follow: true })
    animated.value = false
    engine.setScene(sceneFor(12, 3), 'spring', { follow: true })
    expect(lineScale(lines[2]!)).toBe(0.97)
    expect(lineScale(lines[3]!)).toBe(1)
    const before = lineY(lines[3]!)
    engine.browseBy(27, { snap: true })
    expect(lineY(lines[3]!)).toBe(before - 27)
    expect(lineScale(lines[3]!)).toBe(1)
    expect(lineScale(lines[2]!)).toBe(1)
    expect(rafCallbacks).toHaveLength(0)
    wrapper.unmount()
  })

  it('samples existing viewport and browsing state only when diagnostics are enabled', () => {
    const { engine, lines, wrapper, debugEnabled } = createHarness(30)
    try {
      debugEnabled.value = true
      engine.remeasure()
      expect(engine.readDebugSnapshot()).toMatchObject({
        mountedLineCount: 30,
        stagedLineCount: 0,
        visibleLineCount: 0,
        anchorIndex: -1,
      })
      debugEnabled.value = false
      engine.setScene(sceneFor(30, 0), 'none', { follow: true })
      expect(engine.readDebugSnapshot()).toBeNull()
      debugEnabled.value = true
      const initial = engine.readDebugSnapshot()!
      expect(initial.mountedLineCount).toBe(30)
      expect(initial.stagedLineCount).toBe(onstage(lines).length)
      expect(initial.visibleLineCount).toBe(6)
      expect(initial.scrollMode).toBe('follow')
      expect(initial.frameScheduled).toBe(false)
      engine.browseBy(140, { snap: true })
      expect(engine.readDebugSnapshot()).toMatchObject({ scrollMode: 'browse', anchorIndex: 0 })
      engine.setScene(sceneFor(30, 10), 'spring', { follow: true })
      expect(engine.readDebugSnapshot()?.frameScheduled).toBe(true)
      engine.reset()
      expect(engine.readDebugSnapshot()).toMatchObject({
        mountedLineCount: 0,
        visibleLineCount: 0,
        anchorIndex: -1,
        frameScheduled: false,
        scrollMode: 'follow',
      })
      debugEnabled.value = false
      expect(engine.readDebugSnapshot()).toBeNull()
    } finally {
      wrapper.unmount()
    }
  })

  it('hides lines that are far outside the viewport and shows them again when they return', () => {
    const { engine, lines, wrapper } = createHarness(30)
    engine.setScene(sceneFor(30, 0), 'none', { follow: true })

    // 第 20 行在 232 + 20 × 70 = 1632,远在视口之外
    expect(lines[20]!.style.visibility).toBe('hidden')
    expect(lines[3]!.style.visibility).toBe('')

    engine.setScene(sceneFor(30, 20), 'none', { follow: true })
    expect(lines[20]!.style.visibility).toBe('')
    expect(lines[3]!.style.visibility).toBe('hidden')
    wrapper.unmount()
  })

  it.each([1, -1])(
    'carries one directional wave through visible rows on both sides of the focus (direction: %i)',
    (direction) => {
      const { engine, lines, wrapper } = createHarness(20)
      engine.setScene(sceneFor(20, 6), 'none', { follow: true })
      const focus = 6 + direction
      // 观察当前句两侧实际可见的行，不只检查虚拟窗口的边缘。
      const indices = [focus - 2, focus - 1, focus, focus + 1, focus + 2]
      const ordered = direction > 0 ? indices : [...indices].reverse()
      const before = lines.map(lineY)
      engine.setScene(sceneFor(20, focus), 'spring', { follow: true, budgetMs: 2000 })
      expect(indices.map((index) => lineY(lines[index]!))).toEqual(
        indices.map((index) => before[index]),
      )

      const startedAt = new Map<number, number>()
      for (let elapsed = 2; elapsed <= 440; elapsed += 2) {
        runFrames(1, 2)
        for (const index of indices) {
          if (!startedAt.has(index) && (before[index]! - lineY(lines[index]!)) * direction > 0.01) {
            startedAt.set(index, elapsed)
          }
        }
        expectNoCrossing(lines, LINE)
      }
      expect(startedAt.size).toBe(indices.length)
      for (let position = 1; position < ordered.length; position += 1) {
        // 旧行也要逐行跟随，不能整个上半区同起同落、只让下半区错峰。
        expect(
          startedAt.get(ordered[position]!)! - startedAt.get(ordered[position - 1]!)!,
        ).toBeGreaterThanOrEqual(direction > 0 ? 36 : 25)
      }
      runFrames(90)
      for (const index of indices) {
        expect(lineY(lines[index]!)).toBeCloseTo(engine.targets()[index]!, 2)
      }
      expect(rafCallbacks).toHaveLength(0)
      wrapper.unmount()
    },
  )

  it.each([
    [400, 1],
    [600, 1],
    [1000, 1],
    [400, -1],
    [600, -1],
    [1000, -1],
  ])(
    'bounds focus and whole-wave startup across viewport sizes (%i px, direction: %i)',
    (height, direction) => {
      const { engine, lines, viewport, wrapper } = createHarness(40)
      defineReadonlyNumber(viewport, 'clientHeight', height)
      engine.setScene(sceneFor(40, 12), 'none', { follow: true })
      const focus = 12 + direction
      const before = lines.map(lineY)
      engine.setScene(sceneFor(40, focus), 'spring', { follow: true })
      const targets = engine.targets()
      const visible = lines
        .map((line, index) => ({ line, index }))
        .filter(
          ({ line, index }) =>
            line.style.visibility !== 'hidden' &&
            ((before[index]! + LINE > 0 && before[index]! < height) ||
              (targets[index]! + LINE > 0 && targets[index]! < height)),
        )
        .map(({ index }) => index)
      const startedAt = new Map<number, number>()
      for (let elapsed = 4; elapsed <= 440; elapsed += 4) {
        runFrames(1, 4)
        for (const index of visible) {
          if (!startedAt.has(index) && (before[index]! - lineY(lines[index]!)) * direction > 0.01) {
            startedAt.set(index, elapsed)
          }
        }
        expectNoCrossing(lines, LINE)
      }
      expect(startedAt.size).toBe(visible.length)
      // 4ms 采样宽限：保留可辨别的波浪，同时限制当前句与尾行等待。
      expect(startedAt.get(focus)).toBeLessThanOrEqual(164)
      expect(Math.max(...startedAt.values())).toBeLessThanOrEqual(424)
      for (let frame = 0; frame < 90; frame += 1) {
        runFrames(1)
        expectNoCrossing(lines, LINE)
      }
      for (const index of visible) {
        expect(lineY(lines[index]!)).toBeCloseTo(targets[index]!, 2)
      }
      expect(rafCallbacks).toHaveLength(0)
      wrapper.unmount()
    },
  )

  it.each([80, 160, 300])('compresses the whole wave for a short %i ms phrase', (budgetMs) => {
    const { engine, lines, wrapper } = createHarness(20)
    engine.setScene(sceneFor(20, 6), 'none', { follow: true })
    const indices = [4, 5, 6, 7, 8, 9, 10, 11]
    const before = lines.map(lineY)
    engine.setScene(sceneFor(20, 7), 'spring', { follow: true, budgetMs })
    const startedAt = new Map<number, number>()
    for (let elapsed = 4; elapsed <= budgetMs / 2 + 4; elapsed += 4) {
      runFrames(1, 4)
      for (const index of indices) {
        if (!startedAt.has(index) && before[index]! - lineY(lines[index]!) > 0.01)
          startedAt.set(index, elapsed)
      }
      expectNoCrossing(lines, LINE)
    }
    expect(startedAt.size).toBe(indices.length)
    expect(Math.max(...startedAt.values())).toBeLessThanOrEqual(budgetMs / 2 + 4)
    wrapper.unmount()
  })

  it.each([1500, 2500])(
    'retains a discernible wave on each successive %i ms phrase',
    (intervalMs) => {
      const { engine, lines, wrapper } = createHarness(40)
      engine.setScene(sceneFor(40, 12), 'none', { follow: true })
      for (const focus of [13, 14, 15]) {
        const indices = [focus - 2, focus - 1, focus, focus + 1, focus + 2]
        const before = lines.map(lineY)
        engine.setScene(sceneFor(40, focus), 'spring', { follow: true, budgetMs: intervalMs })
        const startedAt = new Map<number, number>()
        for (let elapsed = 2; elapsed <= 440; elapsed += 2) {
          runFrames(1, 2)
          for (const index of indices) {
            if (!startedAt.has(index) && before[index]! - lineY(lines[index]!) > 0.01)
              startedAt.set(index, elapsed)
          }
          expectNoCrossing(lines, LINE)
        }
        expect(startedAt.size).toBe(indices.length)
        for (let slot = 1; slot < indices.length; slot += 1) {
          expect(
            startedAt.get(indices[slot]!)! - startedAt.get(indices[slot - 1]!)!,
          ).toBeGreaterThanOrEqual(36)
        }
        runFrames((intervalMs - 440) / 4, 4)
        expect(lineY(lines[focus]!)).toBeCloseTo(ANCHOR_Y, 2)
      }
      wrapper.unmount()
    },
  )

  it('settles every line on its target and keeps neighbours from crossing on the way', () => {
    const { engine, lines, wrapper } = createHarness(12)
    engine.setScene(sceneFor(12, 2), 'none', { follow: true })
    engine.setScene(sceneFor(12, 6), 'spring', { follow: true })

    for (let frame = 0; frame < 90; frame += 1) {
      expectNoCrossing(lines, LINE)
      runFrames(1)
    }
    expect(lineY(lines[6]!)).toBeCloseTo(ANCHOR_Y, 0)
    expect(rafCallbacks).toHaveLength(0)
    wrapper.unmount()
  })

  it('redirects an in-flight line without a jump in position', () => {
    const { engine, lines, wrapper } = createHarness(12)
    engine.setScene(sceneFor(12, 2), 'none', { follow: true })
    const start = lineY(lines[0]!)
    engine.setScene(sceneFor(12, 3), 'spring', { follow: true })
    runFrames(6)
    const midway = lineY(lines[0]!)
    expect(midway).toBeLessThan(start - 1)
    expect(midway).toBeGreaterThan(start - PITCH)

    engine.setScene(sceneFor(12, 4), 'spring', { follow: true })
    // 位置连续:新目标只改弹簧的目标,不改当前值
    expect(lineY(lines[0]!)).toBeCloseTo(midway, 5)
    runFrames(2)
    // 而且已经起步的行不会被重新按住
    expect(lineY(lines[0]!)).toBeLessThan(midway - 0.5)
    wrapper.unmount()
  })

  it('advances by actual elapsed time from the first frame on high refresh rate displays', () => {
    function positions(stepMs: number) {
      const { engine, lines, wrapper } = createHarness(20)
      engine.setScene(sceneFor(20, 2), 'none', { follow: true })
      engine.setScene(sceneFor(20, 3), 'spring', { follow: true })
      const frames: Array<{ y: number[]; scale: number[] }> = []
      for (let sample = 0; sample < 10; sample += 1) {
        runFrames(16 / stepMs, stepMs)
        frames.push({
          y: lines.slice(0, 9).map(lineY),
          scale: lines.slice(0, 9).map(lineScale),
        })
      }
      wrapper.unmount()
      rafCallbacks = []
      return frames
    }

    const reference = positions(16)
    for (const stepMs of [8, 4]) {
      expect(positions(stepMs)).toEqual(reference)
    }
  })

  it('keeps short or late line budgets fluid instead of snapping most of the travel in a frame', () => {
    function firstTravel(budgetMs: number) {
      const { engine, lines, wrapper } = createHarness(20)
      engine.setScene(sceneFor(20, 2), 'none', { follow: true })
      // 取牵引波首行，隔离错峰等待，检查短预算没有改变弹簧的首帧手感。
      const start = lineY(lines[0]!)
      engine.setScene(sceneFor(20, 3), 'spring', { follow: true, budgetMs })
      runFrames(1)
      const travel = start - lineY(lines[0]!)
      runFrames(30)
      // Short phrases still make useful progress; they do not have to fully settle before interruption.
      expect(Math.abs(lineY(lines[3]!) - ANCHOR_Y)).toBeLessThan(PITCH * 0.15)
      wrapper.unmount()
      rafCallbacks = []
      return travel
    }

    const regular = firstTravel(2000)
    for (const budget of [1, 10, 100, 250]) {
      const travel = firstTravel(budget)
      expect(travel).toBeGreaterThanOrEqual(regular)
      expect(travel).toBeLessThan(regular * 2)
      expect(travel).toBeLessThan(PITCH * 0.06)
    }
  })

  it('settles the follow motion with a restrained tail instead of a visible rebound', () => {
    const { engine, lines, wrapper } = createHarness(20)
    engine.setScene(sceneFor(20, 2), 'none', { follow: true })
    engine.setScene(sceneFor(20, 3), 'spring', { follow: true })
    let overshoot = 0
    for (let frame = 0; frame < 90; frame += 1) {
      runFrames(1)
      overshoot = Math.max(overshoot, ANCHOR_Y - lineY(lines[3]!))
    }
    expect(overshoot).toBeLessThan(PITCH * 0.01)
    expect(lineY(lines[3]!)).toBeCloseTo(ANCHOR_Y, 2)
    expect(rafCallbacks).toHaveLength(0)
    wrapper.unmount()
  })

  it('keeps the same follow trajectory when virtual rows are synchronized without geometry changes', () => {
    function positions(sync: boolean) {
      const { engine, lines, wrapper } = createHarness(20)
      engine.setScene(sceneFor(20, 2), 'none', { follow: true })
      engine.setScene(sceneFor(20, 3), 'spring', { follow: true })
      const frames: number[][] = []
      for (let frame = 0; frame < 30; frame += 1) {
        if (sync) engine.syncMounted()
        runFrames(1)
        frames.push(lines.slice(0, 9).map(lineY))
      }
      wrapper.unmount()
      rafCallbacks = []
      return frames
    }

    expect(positions(true)).toEqual(positions(false))
  })

  it('does not accelerate an in-flight follow animation when only the active set changes', () => {
    function positions(updateActive: boolean) {
      const { engine, lines, wrapper } = createHarness(20)
      engine.setScene(sceneFor(20, 2), 'none', { follow: true })
      engine.setScene(sceneFor(20, 3), 'spring', { follow: true, budgetMs: 1000 })
      runFrames(4)
      if (updateActive) {
        engine.setScene({ ...sceneFor(20, 3), active: [] }, 'spring', {
          follow: true,
          budgetMs: 100,
        })
      }
      const frames: number[][] = []
      for (let frame = 0; frame < 16; frame += 1) {
        runFrames(1)
        frames.push(lines.slice(0, 9).map(lineY))
      }
      wrapper.unmount()
      rafCallbacks = []
      return frames
    }

    expect(positions(true)).toEqual(positions(false))
  })

  it('keeps wheel smoothing unchanged by mounting rows and advancing playback while browsing', () => {
    function positions(updateScene: boolean) {
      const { engine, lines, wrapper } = createHarness(20)
      engine.setScene(sceneFor(20, 2), 'none', { follow: true })
      engine.browseBy(100)
      if (updateScene) engine.syncMounted()
      runFrames(4)
      if (updateScene) engine.setScene(sceneFor(20, 3), 'spring', { budgetMs: 100 })
      const frames: number[][] = []
      for (let frame = 0; frame < 16; frame += 1) {
        runFrames(1)
        frames.push(lines.slice(0, 9).map(lineY))
      }
      expect(engine.isBrowsing()).toBe(true)
      wrapper.unmount()
      rafCallbacks = []
      return frames
    }

    expect(positions(true)).toEqual(positions(false))
  })

  it('uses the remainder of a frame to move rows whose stagger delay has elapsed', () => {
    const { engine, lines, wrapper } = createHarness(20)
    engine.setScene(sceneFor(20, 2), 'none', { follow: true })
    const before = lines.map(lineY)
    engine.setScene(sceneFor(20, 3), 'spring', { follow: true, budgetMs: 10 })
    runFrames(1)
    // 整道牵引波最多等待 5ms；第一帧的剩余时间必须用于积分，不能整帧停在起点。
    lines.slice(0, 9).forEach((line, index) => {
      expect(lineY(line)).toBeLessThan(before[index]! - 0.1)
    })
    wrapper.unmount()
  })

  it.each([
    [false, 'preserve'],
    [true, 'preserve'],
    [false, 'reflow'],
    [true, 'reflow'],
  ] as const)(
    'preserves the follow trajectory during an unchanged measurement (invalidate: %s, %s)',
    (invalidate, mode) => {
      function positions(measure: boolean) {
        const { engine, lines, wrapper } = createHarness(20)
        engine.setScene(sceneFor(20, 2), 'none', { follow: true })
        engine.setScene(sceneFor(20, 3), 'spring', { follow: true })
        runFrames(4)
        if (measure)
          engine.remeasure(
            invalidate,
            mode === 'reflow' ? { transition: 'reflow' } : { preserveMotion: true },
          )
        const sample = () => ({
          y: lines.slice(0, 9).map(lineY),
          scale: lines.slice(0, 9).map(lineScale),
        })
        const frames = [sample()]
        for (let frame = 0; frame < 24; frame += 1) {
          runFrames(1)
          frames.push(sample())
        }
        wrapper.unmount()
        rafCallbacks = []
        return frames
      }

      expect(positions(true)).toEqual(positions(false))
    },
  )

  it.each(['preserve', 'reflow'] as const)(
    'keeps visual positions during changed measurements and follows the new targets (%s)',
    (mode) => {
      const { engine, lines, wrapper } = createHarness(20)
      engine.setScene(sceneFor(20, 2), 'none', { follow: true })
      engine.setScene(sceneFor(20, 3), 'spring', { follow: true })
      runFrames(9)
      const before = lines.slice(0, 8).map(lineY)
      lines.forEach((line) => defineReadonlyNumber(line, 'offsetHeight', LINE * 2))
      engine.remeasure(
        true,
        mode === 'reflow' ? { transition: 'reflow' } : { preserveMotion: true },
      )
      expect(lines.slice(0, 8).map(lineY)).toEqual(before)
      const beforeFocus = lineY(lines[3]!)
      runFrames(1)
      expect(lineY(lines[3]!)).toBeLessThan(beforeFocus)
      runFrames(100)
      expect(lineY(lines[3]!)).toBeCloseTo(VIEWPORT * 0.42 - LINE, 2)
      expect(rafCallbacks).toHaveLength(0)
      wrapper.unmount()
    },
  )

  it('starts every changed layout position together on reflow instead of delaying later rows', () => {
    const { engine, lines, wrapper } = createHarness(20)
    engine.setScene(sceneFor(20, 4), 'none', { follow: true })
    const indices = [2, 3, 4, 5, 6]
    const before = indices.map((index) => lineY(lines[index]!))
    lines.forEach((line) => defineReadonlyNumber(line, 'offsetHeight', LINE * 2))
    engine.remeasure(true, { transition: 'reflow' })
    expect(indices.map((index) => lineY(lines[index]!))).toEqual(before)
    runFrames(1)
    indices.forEach((index, slot) => {
      expect(Math.abs(lineY(lines[index]!) - before[slot]!)).toBeGreaterThan(0.1)
    })
    wrapper.unmount()
  })

  it('keeps existing visual positions when virtual measurements arrive during motion or at rest', () => {
    const { engine, lines, wrapper } = createHarness(20)
    engine.setScene(sceneFor(20, 3), 'none', { follow: true })
    for (const height of [LINE * 1.5, LINE * 2]) {
      const before = lines.slice(0, 8).map(lineY)
      lines.forEach((line) => defineReadonlyNumber(line, 'offsetHeight', height))
      engine.syncMounted()
      expect(lines.slice(0, 8).map(lineY)).toEqual(before)
      runFrames(5)
    }
    runFrames(100)
    expect(lineY(lines[3]!)).toBeCloseTo(VIEWPORT * 0.42 - LINE, 2)
    expect(rafCallbacks).toHaveLength(0)
    wrapper.unmount()
  })

  it('does not restart retained position or scale springs when a virtual row joins the wave', () => {
    function positions(mountRow: boolean) {
      const { engine, lines, wrapper } = createHarness(12, [], {
        getLineCount: () => 20,
        getEstimatedHeight: () => LINE,
      })
      const incoming = lines.pop()!
      engine.setScene(sceneFor(20, 6), 'none', { follow: true })
      engine.setScene(sceneFor(20, 7), 'spring', { follow: true })
      runFrames(5)
      if (mountRow) {
        lines.push(incoming)
        engine.syncMounted()
      }
      const frames: Array<{ y: number[]; scale: number[] }> = []
      for (let frame = 0; frame < 30; frame += 1) {
        frames.push({
          y: lines.slice(0, 10).map(lineY),
          scale: lines.slice(0, 10).map(lineScale),
        })
        runFrames(1)
      }
      wrapper.unmount()
      rafCallbacks = []
      return frames
    }
    expect(positions(true)).toEqual(positions(false))
  })

  it.each([1, -1])(
    'seeks with simultaneous soft movement rather than a cascade (%i)',
    (direction) => {
      const { engine, lines, wrapper } = createHarness(20)
      engine.setScene(sceneFor(20, 6), 'none', { follow: true })
      const indices = [4, 5, 6, 7, 8]
      const before = indices.map((index) => lineY(lines[index]!))
      engine.setScene(sceneFor(20, 6 + direction * 2), 'seek', { follow: true, budgetMs: 1 })
      expect(indices.map((index) => lineY(lines[index]!))).toEqual(before)
      runFrames(1)
      const traveled = indices.map(
        (index, slot) => (before[slot]! - lineY(lines[index]!)) * direction,
      )
      traveled.forEach((value) => {
        expect(value).toBeGreaterThan(0.1)
        expect(value).toBeLessThan(PITCH * 0.06)
        expect(value).toBeCloseTo(traveled[0]!, 2)
      })
      runFrames(100)
      expect(lineY(lines[6 + direction * 2]!)).toBeCloseTo(ANCHOR_Y, 2)
      wrapper.unmount()
    },
  )

  it('caps distant seek travel while starting all incoming rows together', () => {
    const { engine, lines, wrapper } = createHarness(80)
    engine.setScene(sceneFor(80, 2), 'none', { follow: true })
    engine.setScene(sceneFor(80, 60), 'seek', { follow: true })
    const indices = [58, 59, 60, 61]
    const before = indices.map((index) => lineY(lines[index]!))
    indices.forEach((index, slot) => {
      expect(before[slot]! - engine.targets()[index]!).toBeCloseTo(VIEWPORT * 0.55, 2)
    })
    runFrames(1)
    indices.forEach((index, slot) => {
      expect(lineY(lines[index]!)).toBeLessThan(before[slot]! - 0.1)
    })
    runFrames(100)
    expect(lineY(lines[60]!)).toBeCloseTo(ANCHOR_Y, 2)
    wrapper.unmount()
  })

  it('does not schedule an empty animation for a seek that leaves settled targets unchanged', () => {
    const { engine, wrapper } = createHarness(20)
    engine.setScene(sceneFor(20, 6), 'none', { follow: true })
    engine.setScene(sceneFor(20, 6), 'seek', { follow: true })
    expect(rafCallbacks).toHaveLength(0)
    wrapper.unmount()
  })

  it.each(['seek', 'reflow', 'scale'] as const)(
    'keeps an unfinished %s animation alive when multiple RAF callbacks have the same timestamp',
    (operation) => {
      const { engine, lines, viewport, wrapper } = createHarness(20)
      engine.setScene(sceneFor(20, 4), 'none', { follow: true })
      if (operation === 'seek') {
        engine.setScene(sceneFor(20, 6), 'seek', { follow: true })
      } else if (operation === 'reflow') {
        defineReadonlyNumber(viewport, 'clientHeight', 300)
        engine.remeasure(true, { transition: 'reflow' })
      } else {
        engine.setScene({ ...sceneFor(20, 4), playing: false }, 'spring')
      }
      const sample = () => ({
        y: lines.slice(2, 8).map(lineY),
        scale: lines.slice(2, 8).map(lineScale),
      })
      const before = sample()
      runFrames(5, 0)
      expect(sample()).toEqual(before)
      // 没经过时间应等待下一帧，而不是误以为完成而丢失尚未到达的目标。
      expect(rafCallbacks).toHaveLength(1)
      runFrames(120)
      const focus = operation === 'seek' ? 6 : 4
      expect(lineY(lines[focus]!)).toBeCloseTo(engine.targets()[focus]!, 2)
      if (operation === 'scale') expect(lines.slice(2, 8).map(lineScale)).toEqual(Array(6).fill(1))
      expect(rafCallbacks).toHaveLength(0)
      wrapper.unmount()
    },
  )

  it('reports only the actual viewport intersection, including positions during movement', () => {
    const { engine, lines, wrapper } = createHarness(30)
    engine.setScene(sceneFor(30, 6), 'none', { follow: true })
    expect(engine.isRowVisible(2)).toBe(false)
    expect(engine.isRowVisible(3)).toBe(true)
    expect(engine.isRowVisible(20)).toBe(false)
    engine.setScene(sceneFor(30, 8), 'spring', { follow: true })
    expect(engine.isRowVisible(3)).toBe(true)
    runFrames(100)
    expect(lineY(lines[3]!) + LINE).toBeLessThan(0)
    expect(engine.isRowVisible(3)).toBe(false)
    expect(engine.isRowVisible(8)).toBe(true)
    expect(engine.isRowVisible(-1)).toBe(false)
    wrapper.unmount()
  })

  it('preserves harmony expansion when measuring during an in-flight animation', () => {
    function positions(measure: boolean) {
      const background = [false, true, false, false]
      const { engine, lines, wrapper } = createHarness(4, background)
      engine.setScene(sceneFor(4, 0, [], background), 'none', { follow: true })
      engine.setScene(sceneFor(4, 0, [1], background), 'spring', { follow: true })
      runFrames(5)
      if (measure) engine.remeasure(true, { preserveMotion: true })
      const frames: Array<{ open: string; positions: number[] }> = []
      for (let frame = 0; frame < 24; frame += 1) {
        frames.push({
          open: lines[1]!.style.getPropertyValue('--lyric-harmony'),
          positions: lines.map(lineY),
        })
        runFrames(1)
      }
      wrapper.unmount()
      rafCallbacks = []
      return frames
    }

    expect(positions(true)).toEqual(positions(false))
  })

  it.each([1, 10, 30])(
    'keeps rapid scene changes stable when only %i ms remain before the next line',
    (budgetMs) => {
      const { engine, lines, wrapper } = createHarness(20)
      engine.setScene(sceneFor(20, 2), 'none', { follow: true })
      for (const focus of [3, 5, 4, 8, 6]) {
        engine.setScene(sceneFor(20, focus), 'spring', { follow: true, budgetMs })
        runFrames(2)
      }
      runFrames(90)
      expect(lines[6]!.style.visibility).not.toBe('hidden')
      expect(lineY(lines[6]!)).toBeCloseTo(ANCHOR_Y, 0)
      expectNoCrossing(lines, LINE)
      expect(rafCallbacks).toHaveLength(0)
      wrapper.unmount()
    },
  )

  it('caps the travel of a far jump so incoming lines cascade in from just outside the viewport', () => {
    const { engine, lines, wrapper } = createHarness(80)
    engine.setScene(sceneFor(80, 2), 'none', { follow: true })

    engine.setScene(sceneFor(80, 60), 'spring', { follow: true })
    // 目标行不会从 4000px 外飞过来:起点被封顶在 0.55 个视口以内
    const start = lineY(lines[60]!)
    expect(start - ANCHOR_Y).toBeLessThanOrEqual(VIEWPORT * 0.55 + 0.01)
    expect(start - ANCHOR_Y).toBeGreaterThan(VIEWPORT * 0.5)
    // 离开的行早已在视口外,直接就位
    expect(lines[2]!.style.visibility).toBe('hidden')

    runFrames(90)
    expect(lineY(lines[60]!)).toBeCloseTo(ANCHOR_Y, 0)
    wrapper.unmount()
  })

  it('keeps layout order across the stage edge when a wheel tick lands mid-jump', () => {
    // 跳转时边缘之外的行若直接就位,进场的行会从它们身上穿过去;
    // 动画没完就滚滚轮,那片区域被推进视口,屏上就是两行叠在一起
    const { engine, lines, wrapper } = createHarness(80)
    engine.setScene(sceneFor(80, 2), 'none', { follow: true })
    engine.setScene(sceneFor(80, 40), 'spring', { follow: true })
    runFrames(6)
    engine.browseBy(240)

    for (let frame = 0; frame < 60; frame += 1) {
      expectNoCrossing(lines, LINE)
      runFrames(1)
    }
    wrapper.unmount()
  })

  it('pushes the lines below a harmony down when it opens and pulls them back when it closes', () => {
    const background = [false, true, false, false]
    const { engine, lines, wrapper } = createHarness(4, background)
    engine.setScene(sceneFor(4, 0, [], background), 'none', { follow: true })
    const closedY = lineY(lines[2]!)
    // 收起时和声不占位:第 2 行紧接在第 0 行之后
    expect(closedY).toBeCloseTo(ANCHOR_Y + PITCH, 5)

    engine.setScene(sceneFor(4, 0, [1], background), 'spring', { follow: true })
    runFrames(80)
    expect(lineY(lines[2]!)).toBeCloseTo(closedY + HARMONY + HARMONY_GAP, 0)
    // 和声自己从主句下沿探出来一个 harmonyGap
    expect(lineY(lines[1]!)).toBeCloseTo(ANCHOR_Y + LINE + HARMONY_GAP, 0)

    engine.setScene(sceneFor(4, 0, [], background), 'spring', { follow: true })
    runFrames(80)
    expect(lineY(lines[2]!)).toBeCloseTo(closedY, 0)
    wrapper.unmount()
  })

  it('keeps the next line clear of the harmony while it opens and closes', () => {
    // 占位与裁切由同一根弹簧驱动:任何一帧,下一行的顶都不会高过和声已展开的部分
    const background = [false, true, false, false]
    const { engine, lines, wrapper } = createHarness(4, background)
    engine.setScene(sceneFor(4, 0, [], background), 'none', { follow: true })
    expect(lines[1]!.style.getPropertyValue('--lyric-harmony')).toBe('0.000')

    const check = () => {
      const open = Number(lines[1]!.style.getPropertyValue('--lyric-harmony'))
      const visibleBottom = lineY(lines[1]!) + HARMONY * open
      expect(lineY(lines[2]!)).toBeGreaterThanOrEqual(visibleBottom - 0.01)
      // 开合过程中的中间值也要写出去,视觉才跟得上占位
      expect(open).toBeGreaterThanOrEqual(0)
      expect(open).toBeLessThanOrEqual(1)
    }

    engine.setScene(sceneFor(4, 0, [1], background), 'spring', { follow: true })
    let sawMidway = false
    for (let frame = 0; frame < 60; frame += 1) {
      runFrames(1)
      check()
      const open = Number(lines[1]!.style.getPropertyValue('--lyric-harmony'))
      if (open > 0.2 && open < 0.8) sawMidway = true
    }
    expect(sawMidway).toBe(true)
    expect(lines[1]!.style.getPropertyValue('--lyric-harmony')).toBe('1.000')

    engine.setScene(sceneFor(4, 0, [], background), 'spring', { follow: true })
    for (let frame = 0; frame < 60; frame += 1) {
      runFrames(1)
      check()
    }
    expect(lines[1]!.style.getPropertyValue('--lyric-harmony')).toBe('0.000')
    wrapper.unmount()
  })

  it('snaps everything when animation is disabled', () => {
    const { engine, lines, animated, wrapper } = createHarness(6)
    animated.value = false
    engine.setScene(sceneFor(6, 1), 'none', { follow: true })
    engine.setScene(sceneFor(6, 3), 'spring', { follow: true })

    expect(lineY(lines[3]!)).toBeCloseTo(ANCHOR_Y, 5)
    expect(rafCallbacks).toHaveLength(0)
    wrapper.unmount()
  })

  it.each(['spring', 'seek'] as const)(
    'lets a stiffer coefficient settle faster (%s)',
    (transition) => {
      function remainingAfter(scale: number) {
        const { engine, lines, spring, wrapper } = createHarness(8)
        spring.value = scale
        engine.setScene(sceneFor(8, 1), 'none', { follow: true })
        const start = lineY(lines[1]!)
        engine.setScene(sceneFor(8, 3), transition, { follow: true })
        runFrames(8)
        const remaining = Math.abs(lineY(lines[1]!) - (start - 2 * PITCH))
        wrapper.unmount()
        return remaining
      }

      expect(remainingAfter(2)).toBeLessThan(remainingAfter(0.5))
    },
  )

  it('browses by wheel deltas, clamps at both ends and follows again on demand', () => {
    const { engine, lines, wrapper } = createHarness(6)
    engine.setScene(sceneFor(6, 2), 'none', { follow: true })

    engine.browseBy(100)
    runFrames(60)
    expect(engine.isBrowsing()).toBe(true)
    expect(lineY(lines[2]!)).toBeCloseTo(ANCHOR_Y - 100, 0)

    // 上界:第一行的中线不会越过锚点
    engine.browseBy(-10000)
    runFrames(60)
    expect(lineY(lines[0]!)).toBeCloseTo(ANCHOR_Y, 0)
    // 下界:最后一行的中线不会越过锚点
    engine.browseBy(10000)
    runFrames(60)
    expect(lineY(lines[5]!)).toBeCloseTo(ANCHOR_Y, 0)

    // 期间场景变化只更新目标,不抢走用户的滚动位置
    engine.setScene(sceneFor(6, 3), 'spring')
    runFrames(60)
    expect(lineY(lines[5]!)).toBeCloseTo(ANCHOR_Y, 0)

    engine.follow('spring')
    runFrames(90)
    expect(engine.isBrowsing()).toBe(false)
    expect(lineY(lines[3]!)).toBeCloseTo(ANCHOR_Y, 0)
    wrapper.unmount()
  })

  it('keeps the same browsed line at the viewport edge when font or translation changes remeasure all heights', () => {
    const { engine, lines, wrapper } = createHarness(30)
    engine.setScene(sceneFor(30, 10), 'none', { follow: true })
    engine.browseBy(120, { snap: true })
    // 第 8 行在视口上沿部分可见，排版更新后不应跳到前面的歌词。
    const before = lineY(lines[8]!)
    expect(before).toBeLessThan(0)
    expect(before + LINE).toBeGreaterThan(0)
    for (const line of lines) defineReadonlyNumber(line, 'offsetHeight', LINE * 2)

    engine.remeasure(true)
    expect(engine.isBrowsing()).toBe(true)
    expect(lineY(lines[8]!)).toBeCloseTo(before, 5)
    expect(lineY(lines[9]!)).toBeCloseTo(before + LINE * 2 + GAP, 5)
    engine.follow('none')
    expect(lineY(lines[10]!)).toBeCloseTo(VIEWPORT * 0.42 - LINE, 5)
    wrapper.unmount()
  })

  it('preserves the browsing anchor when offscreen virtual height estimates change', () => {
    let estimatedHeight = LINE
    const { engine, lines, wrapper } = createHarness(16, [], {
      getLineCount: () => 2000,
      getEstimatedHeight: () => estimatedHeight,
    })
    lines.forEach((line, slot) => {
      line.dataset.lyricIndex = String(990 + slot)
    })
    engine.setScene(sceneFor(2000, 1000), 'none', { follow: true })
    engine.browseBy(120, { snap: true })
    const before = lineY(lines[8]!)
    estimatedHeight = LINE * 2
    for (const line of lines) defineReadonlyNumber(line, 'offsetHeight', estimatedHeight)

    engine.remeasure(true)
    expect(lineY(lines[8]!)).toBeCloseTo(before, 5)
    expect(lineY(lines[9]!)).toBeCloseTo(before + LINE * 2 + GAP, 5)
    expect(engine.isBrowsing()).toBe(true)
    wrapper.unmount()
  })

  it('restores the browsing anchor after a remeasure finishes an in-progress harmony expansion', () => {
    const background = Array.from({ length: 30 }, (_, index) => index === 6)
    const { engine, lines, wrapper } = createHarness(30, background)
    engine.setScene(sceneFor(30, 10, [], background), 'none', { follow: true })
    engine.browseBy(120, { snap: true })
    engine.setScene(sceneFor(30, 10, [6], background), 'spring')
    runFrames(5)
    const before = lineY(lines[8]!)
    expect(before).toBeLessThan(0)
    expect(before + LINE).toBeGreaterThan(0)
    lines.forEach((line, index) => {
      defineReadonlyNumber(line, 'offsetHeight', (background[index] ? HARMONY : LINE) * 2)
    })

    engine.remeasure(true)
    expect(lineY(lines[8]!)).toBeCloseTo(before, 2)
    expect(lineY(lines[9]!)).toBeCloseTo(before + LINE * 2 + GAP, 2)
    wrapper.unmount()
  })

  it('does not overwrite a usable layout with hidden zero-height measurements', () => {
    const { engine, lines, viewport, wrapper } = createHarness(30)
    engine.setScene(sceneFor(30, 10), 'none', { follow: true })
    engine.browseBy(120, { snap: true })
    const before = lineY(lines[8]!)
    defineReadonlyNumber(viewport, 'clientHeight', 0)
    for (const line of lines) defineReadonlyNumber(line, 'offsetHeight', 0)
    engine.remeasure(true)
    expect(lineY(lines[8]!)).toBeCloseTo(before, 5)

    defineReadonlyNumber(viewport, 'clientHeight', 400)
    for (const line of lines) defineReadonlyNumber(line, 'offsetHeight', LINE * 2)
    engine.remeasure(true)
    expect(lineY(lines[8]!)).toBeCloseTo(before, 5)
    engine.follow('none')
    expect(lineY(lines[10]!)).toBeCloseTo(400 * 0.42 - LINE, 5)
    wrapper.unmount()
  })

  it('publishes an estimated virtual window before the first measurable viewport and after a track reset', () => {
    const onWindowChange = vi.fn()
    const { engine, viewport, wrapper } = createHarness(0, [], {
      getLineCount: () => 100,
      getEstimatedHeight: () => LINE,
      onWindowChange,
    })
    defineReadonlyNumber(viewport, 'clientHeight', 0)
    engine.setScene(sceneFor(100, 50), 'none', { follow: true })
    expect(onWindowChange).toHaveBeenLastCalledWith(expect.arrayContaining([50]))

    defineReadonlyNumber(viewport, 'clientHeight', VIEWPORT)
    engine.remeasure()
    engine.reset()
    defineReadonlyNumber(viewport, 'clientHeight', 0)
    engine.setScene(sceneFor(100, 20), 'none', { follow: true })
    expect(onWindowChange).toHaveBeenLastCalledWith(expect.arrayContaining([20]))
    wrapper.unmount()
  })

  it('tracks the finger exactly while dragging and coasts after release', () => {
    const { engine, lines, wrapper } = createHarness(20)
    engine.setScene(sceneFor(20, 2), 'none', { follow: true })
    const start = lineY(lines[2]!)

    engine.browseBy(37, { snap: true })
    // 手指拖动:没有弹簧,立刻到位
    expect(lineY(lines[2]!)).toBeCloseTo(start - 37, 5)

    engine.fling(800)
    runFrames(10)
    const coasted = lineY(lines[2]!)
    expect(coasted).toBeLessThan(start - 37 - 20)
    runFrames(120)
    // 惯性衰减后停下,循环也停
    expect(rafCallbacks).toHaveLength(0)
    expect(lineY(lines[2]!)).toBeLessThan(coasted)
    wrapper.unmount()
  })

  it('brings a line into view for keyboard focus only when it is outside the viewport', () => {
    const { engine, lines, wrapper } = createHarness(30)
    engine.setScene(sceneFor(30, 2), 'none', { follow: true })

    expect(engine.reveal(3)).toBe(false)
    expect(engine.reveal(20)).toBe(true)
    runFrames(60)
    const y = lineY(lines[20]!)
    expect(y).toBeGreaterThan(0)
    expect(y + LINE).toBeLessThanOrEqual(VIEWPORT * 0.88 + 0.5)
    wrapper.unmount()
  })

  it('leaves the old lines in place and stops driving them on reset', () => {
    // 歌词列表整体更换时旧行还要带着自己的位置淡出,不能清成一堆
    const { engine, lines, wrapper } = createHarness(30)
    engine.setScene(sceneFor(30, 2), 'none', { follow: true })
    engine.setScene(sceneFor(30, 5), 'spring', { follow: true })
    const before = lineY(lines[0]!)

    engine.reset()
    expect(lineY(lines[0]!)).toBe(before)
    runFrames(6)
    expect(lineY(lines[0]!)).toBe(before)
    expect(rafCallbacks).toHaveLength(0)
    wrapper.unmount()
  })
})
