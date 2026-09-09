import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { useLyricsEngine, type LyricsSceneInput } from '../composables/useLyricsEngine'

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
}

function createHarness(count: number, background: boolean[] = []): Harness {
  const lines: HTMLElement[] = []
  let viewport: HTMLElement | undefined
  const animated = { value: true }
  const spring = { value: 1 }
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
  return { wrapper, engine, lines, viewport: viewport!, animated, spring }
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

  it('starts the top line first and holds the lower lines when the content moves up', () => {
    const { engine, lines, wrapper } = createHarness(12)
    engine.setScene(sceneFor(12, 2), 'none', { follow: true })
    const before = lines.map(lineY)

    engine.setScene(sceneFor(12, 3), 'spring', { follow: true })
    // 目标变了,位置还在原处:弹簧只改目标(最后一行在视口外,直接就位)
    expect(lines.slice(0, 11).map(lineY)).toEqual(before.slice(0, 11))

    runFrames(3)
    // 48ms 后:最上面的可见行已经在走,视口下方的行还被按在原地
    expect(lineY(lines[0]!)).toBeLessThan(before[0]! - 1)
    expect(lineY(lines[7]!)).toBeCloseTo(before[7]!, 1)
    wrapper.unmount()
  })

  it('starts from the bottom when the content moves down', () => {
    const { engine, lines, wrapper } = createHarness(12)
    engine.setScene(sceneFor(12, 5), 'none', { follow: true })
    const before = lines.map(lineY)

    engine.setScene(sceneFor(12, 4), 'spring', { follow: true })
    runFrames(3)

    // 往回跳时波从下面往上传:视口内最下面的行先动(舞台边缘外的行跟它同步),上面的行等着
    expect(lineY(lines[11]!)).toBeGreaterThan(before[11]! + 1)
    expect(lineY(lines[10]!)).toBeGreaterThan(before[10]! + 1)
    expect(lineY(lines[8]!)).toBeCloseTo(before[8]!, 1)
    expect(lineY(lines[2]!)).toBeCloseTo(before[2]!, 1)
    wrapper.unmount()
  })

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

  it('lets a stiffer spring coefficient settle faster', () => {
    function remainingAfter(scale: number) {
      const { engine, lines, spring, wrapper } = createHarness(8)
      spring.value = scale
      engine.setScene(sceneFor(8, 1), 'none', { follow: true })
      const start = lineY(lines[1]!)
      engine.setScene(sceneFor(8, 3), 'spring', { follow: true })
      runFrames(8)
      const remaining = Math.abs(lineY(lines[1]!) - (start - 2 * PITCH))
      wrapper.unmount()
      return remaining
    }

    expect(remainingAfter(2)).toBeLessThan(remainingAfter(0.5))
  })

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
