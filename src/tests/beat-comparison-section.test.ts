import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BeatComparisonSection from '../components/BeatComparisonSection.vue'
import {
  createBeatComparisonSnapshot,
  type BeatComparisonSample,
  type BeatComparisonSnapshot,
} from '../core/analysis/beat-comparison'

function sample(sampledAtMs: number): BeatComparisonSample {
  return {
    sampledAtMs,
    playbackSeconds: sampledAtMs / 1000,
    sampleSeconds: sampledAtMs / 1000 - 0.05,
    flashRate: 1,
    actual: {
      sampledAtMs,
      level: 0.9,
      sustain: 0.3,
      rawLevel: 0.7,
      rawSustain: 0.5,
      readyMix: 1,
      playbackSeconds: sampledAtMs / 1000,
      sampleSeconds: sampledAtMs / 1000 - 0.05,
      delayMs: 50,
      playing: true,
      seeking: false,
      canHighlight: true,
      reason: 'ready',
      timing: {
        clockSource: 'media',
        frameLeadMs: 0,
        outputOffsetMs: 0,
        timelineSource: 'provisional',
        firstAvailableMs: 300,
        lastWriteAtMs: sampledAtMs,
        handoffPending: false,
      },
    },
    candidates: {
      basic: { level: 0.2, sustain: 0.5 },
      'beat-this-small': { level: 0.4, sustain: 0.5 },
      'beat-this-standard': { level: 0.6, sustain: 0.5 },
    },
  }
}

function snapshot(history = [sample(20_000), sample(20_100)]): BeatComparisonSnapshot {
  const state = createBeatComparisonSnapshot()
  state.phase = 'running'
  state.actualMode = 'beat-this-small'
  state.epoch = 1
  state.history = history
  state.current = history.at(-1) ?? null
  for (const route of state.routes) {
    route.status = 'ready'
    route.phase = 'buffered'
    route.progress = 1
  }
  return state
}

function button(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((element) => element.text() === text)!
}

afterEach(() => vi.unstubAllGlobals())

describe('BeatComparisonSection', () => {
  it('shows model backend and separates warm inference from session initialization', () => {
    const state = snapshot()
    state.routes[1]!.metrics = {
      totalMs: 550,
      initializationMs: 0,
      inferenceMs: 120,
      sessionReused: true,
      backend: 'wasm',
      featureFrames: 1500,
      reusedFeatureFrames: 300,
    }
    const wrapper = mount(BeatComparisonSection, {
      props: { snapshot: state, playbackSeconds: 20, canStart: false },
    })
    expect(
      wrapper.get('[data-testid="comparison-timing-beat-this-small"]').text().replace(/\s+/g, ' '),
    ).toContain('复用会话 · wasm')
    expect(
      wrapper.get('[data-testid="comparison-timing-beat-this-small"]').text().replace(/\s+/g, ' '),
    ).toContain('本段 0.55 s · 初始化 0.00 s · 模型推理 0.12 s')
    expect(wrapper.text().replace(/\s+/g, ' ')).toContain('特征复用 300 / 1500 帧')
    wrapper.unmount()
  })
  it('exports the recorded session independently from chart filters, freezing and live construction', async () => {
    const wrapper = mount(BeatComparisonSection, {
      props: {
        snapshot: snapshot(),
        playbackSeconds: 20.1,
        canStart: false,
        exportSampleCount: 2400,
      },
    })
    expect(wrapper.get('[data-testid="comparison-export-count"]').text()).toBe('已记录 2400 条')
    await button(wrapper, '冻结图表').trigger('click')
    await button(wrapper, '持续能量').trigger('click')
    for (const label of ['实际背景输出', '基础算法', 'Small', '标准版'])
      await wrapper.get(`button[aria-label="显示${label}曲线"]`).trigger('click')
    expect(wrapper.findAll('.comparison-curve')).toHaveLength(0)
    expect(button(wrapper, '导出 JSON').attributes('disabled')).toBeUndefined()
    await button(wrapper, '导出 JSON').trigger('click')
    expect(wrapper.emitted('export')).toEqual([[]])
    expect(wrapper.emitted('stop')).toBeUndefined()
    expect(wrapper.text()).toContain('本曲会话已记录的四路数据')
    expect(wrapper.text()).toContain('缺少音频或人工拍点标注')
    wrapper.unmount()
  })

  it('disables export without session samples or while exporting, and retains access with an empty visible chart', async () => {
    const wrapper = mount(BeatComparisonSection, {
      props: { snapshot: snapshot(), playbackSeconds: 20.1, canStart: false },
    })
    expect(button(wrapper, '导出 JSON').attributes('disabled')).toBeDefined()
    await button(wrapper, '导出 JSON').trigger('click')
    expect(wrapper.emitted('export')).toBeUndefined()
    await wrapper.setProps({ snapshot: null, exportSampleCount: 1200 })
    expect(wrapper.findAll('.comparison-curve')).toHaveLength(0)
    expect(button(wrapper, '导出 JSON').attributes('disabled')).toBeUndefined()
    await wrapper.setProps({ exporting: true })
    expect(button(wrapper, '正在导出…').attributes('disabled')).toBeDefined()
    expect(button(wrapper, '正在导出…').attributes('aria-busy')).toBe('true')
    await button(wrapper, '正在导出…').trigger('click')
    expect(wrapper.emitted('export')).toBeUndefined()
    await wrapper.setProps({ exporting: false })
    await button(wrapper, '导出 JSON').trigger('click')
    expect(wrapper.emitted('export')).toEqual([[]])
    wrapper.unmount()
  })

  it('announces export errors and makes retention truncation explicit without exposing signed addresses', async () => {
    const wrapper = mount(BeatComparisonSection, {
      props: {
        snapshot: snapshot(),
        playbackSeconds: 20.1,
        canStart: false,
        exportSampleCount: 20_000,
        exportTruncated: true,
      },
    })
    expect(wrapper.text()).toContain('记录已达到上限，导出保留最近的记录')
    const feedback = wrapper.get('[aria-live="polite"]')
    expect(feedback.text()).toBe('')
    await wrapper.setProps({ exportError: '导出失败 https://example.test/data?token=private' })
    expect(feedback.text()).toContain('导出失败 [地址已隐藏]')
    expect(feedback.text()).not.toContain('token=private')
    await wrapper.setProps({ exportError: null, exportTruncated: false })
    expect(feedback.text()).toBe('')
    expect(wrapper.text()).not.toContain('记录已达到上限')
    wrapper.unmount()
  })

  it('requires explicit activation and supports stopping candidate construction', async () => {
    const wrapper = mount(BeatComparisonSection, {
      props: { snapshot: null, playbackSeconds: 22, canStart: false },
    })
    expect(wrapper.emitted('start')).toBeUndefined()
    expect(button(wrapper, '开启实时对比').attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('.comparison-curve')).toHaveLength(0)
    await wrapper.setProps({ canStart: true })
    await button(wrapper, '开启实时对比').trigger('click')
    expect(wrapper.emitted('start')).toEqual([[]])
    const state = snapshot()
    state.routes[2]!.status = 'running'
    state.routes[2]!.phase = 'analysing'
    state.routes[2]!.progress = 0.3
    await wrapper.setProps({ snapshot: state, canStart: false })
    expect(button(wrapper, '开启实时对比').attributes('disabled')).toBeDefined()
    await button(wrapper, '停止构建').trigger('click')
    expect(wrapper.emitted('stop')).toEqual([[]])
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('30')
    expect(wrapper.text()).not.toContain('固定片段')
    expect(wrapper.text()).not.toContain('播放这段')
    wrapper.unmount()
  })

  it('shows a distinct actual-output curve and values while all four series scroll together', async () => {
    const wrapper = mount(BeatComparisonSection, {
      props: { snapshot: snapshot(), playbackSeconds: 20.1, canStart: false },
    })
    const curves = wrapper.findAll('.comparison-curve')
    expect(curves).toHaveLength(4)
    expect(curves.map((curve) => curve.attributes('d')?.match(/[ML]\d+\.\d+/g))).toEqual(
      Array.from({ length: 4 }, () => ['M465.81', 'L468.00']),
    )
    expect(
      wrapper
        .get('[data-testid="comparison-curve-beat-this-small"]')
        .attributes('stroke-dasharray'),
    ).toBe('7 4')
    expect(
      wrapper
        .get('[data-testid="comparison-curve-beat-this-standard"]')
        .attributes('stroke-dasharray'),
    ).toBe('1 4')
    expect(wrapper.get('[data-testid="comparison-value-actual"]').text()).toBe('0.900')
    expect(wrapper.get('[data-testid="comparison-value-basic"]').text()).toBe('0.200')
    expect(wrapper.get('[data-testid="comparison-actual-source"]').text()).toContain(
      '当前设置 Beat This! Small · 实际来源 临时基础高亮',
    )
    await wrapper.setProps({ snapshot: snapshot([sample(20_000), sample(20_100), sample(20_200)]) })
    expect(wrapper.get('[data-testid="comparison-curve-actual"]').attributes('d')).toContain(
      'M463.62',
    )
    wrapper.unmount()
  })

  it('freezes only the graph while current values update and resumes at the latest observation', async () => {
    const initial = snapshot()
    const wrapper = mount(BeatComparisonSection, {
      props: { snapshot: initial, playbackSeconds: 20.1, canStart: false },
    })
    const before = wrapper.get('[data-testid="comparison-curve-actual"]').attributes('d')
    await button(wrapper, '冻结图表').trigger('click')
    const nextSample = sample(20_200)
    nextSample.actual.level = 0.123
    const next = snapshot([...initial.history, nextSample])
    await wrapper.setProps({ snapshot: next })
    expect(wrapper.get('[data-testid="comparison-curve-actual"]').attributes('d')).toBe(before)
    expect(wrapper.get('[data-testid="comparison-value-actual"]').text()).toBe('0.123')
    expect(wrapper.emitted('stop')).toBeUndefined()
    await button(wrapper, '恢复滚动').trigger('click')
    expect(wrapper.get('[data-testid="comparison-curve-actual"]').attributes('d')).not.toBe(before)
    await button(wrapper, '冻结图表').trigger('click')
    await wrapper.setProps({ snapshot: { ...next, epoch: 2 } })
    expect(wrapper.findAll('.comparison-curve')).toHaveLength(0)
    await button(wrapper, '恢复滚动').trigger('click')
    expect(wrapper.findAll('.comparison-curve')).toHaveLength(4)
    wrapper.unmount()
  })

  it('independently hides actual or candidate curves and switches to observed sustain', async () => {
    const wrapper = mount(BeatComparisonSection, {
      props: { snapshot: snapshot(), playbackSeconds: 20.1, canStart: false },
    })
    const actualToggle = wrapper.get('button[aria-label="显示实际背景输出曲线"]')
    await actualToggle.trigger('click')
    expect(actualToggle.attributes('aria-pressed')).toBe('false')
    expect(wrapper.findAll('.comparison-curve')).toHaveLength(3)
    await wrapper.get('button[aria-label="显示Small曲线"]').trigger('click')
    expect(wrapper.findAll('.comparison-curve')).toHaveLength(2)
    await actualToggle.trigger('click')
    await button(wrapper, '持续能量').trigger('click')
    expect(wrapper.get('[data-testid="comparison-value-actual"]').text()).toBe('0.300')
    expect(wrapper.get('[data-testid="comparison-value-basic"]').text()).toBe('0.500')
    expect(wrapper.get('[data-testid="comparison-curve-actual"]').attributes('d')).toContain(
      '102.20',
    )
    wrapper.unmount()
  })

  it('shows actual output before candidates are available and never backfills missing model samples', async () => {
    const observations = [sample(20_000), sample(20_100)]
    for (const observation of observations)
      observation.candidates = {
        basic: null,
        'beat-this-small': null,
        'beat-this-standard': null,
      }
    const state = snapshot(observations)
    state.phase = 'idle'
    state.routes[2]!.status = 'unavailable'
    state.routes[2]!.error = '无法读取 https://media.example/model?token=private'
    const wrapper = mount(BeatComparisonSection, {
      props: { snapshot: state, playbackSeconds: 20.1, canStart: true },
    })
    expect(wrapper.findAll('.comparison-curve')).toHaveLength(1)
    expect(wrapper.get('[data-testid="comparison-value-beat-this-small"]').text()).toBe('—')
    expect(wrapper.text()).toContain('请在设置中手动下载此模型')
    expect(wrapper.text()).not.toContain('token=private')
    const after = snapshot([...observations, sample(20_200)])
    await wrapper.setProps({ snapshot: after })
    expect(wrapper.get('[data-testid="comparison-curve-beat-this-small"]').attributes('d')).toBe(
      'M468.00,89.60',
    )
    wrapper.unmount()
  })

  it('respects reduced motion until the user explicitly resumes scrolling', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    )
    const state = snapshot()
    const wrapper = mount(BeatComparisonSection, {
      props: { snapshot: state, playbackSeconds: 20.1, canStart: false },
    })
    const before = wrapper.get('[data-testid="comparison-curve-actual"]').attributes('d')
    await wrapper.setProps({ snapshot: snapshot([...state.history, sample(20_200)]) })
    expect(wrapper.get('[data-testid="comparison-curve-actual"]').attributes('d')).toBe(before)
    expect(wrapper.text()).toContain('减少动态效果设置冻结图表')
    await button(wrapper, '恢复滚动').trigger('click')
    expect(wrapper.get('[data-testid="comparison-curve-actual"]').attributes('d')).not.toBe(before)
    wrapper.unmount()
  })
})
