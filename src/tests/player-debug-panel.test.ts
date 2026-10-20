import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PlayerDebugPanel from '../components/PlayerDebugPanel.vue'
import type {
  BeatDebugQueueItem,
  BeatDebugSample,
  BeatDebugSnapshot,
  BeatSchedulerDebug,
} from '../core/analysis/beat-debug'
import type { AudioPreloadDebug } from '../core/analysis/player-debug'
import type { Track } from '../core/types'

const privateUrl = 'https://media.example/song.mp3?token=private-token'
function sample(overrides: Partial<BeatDebugSample> = {}): BeatDebugSample {
  return {
    sampledAtMs: 1000,
    level: 0.6,
    sustain: 0.2,
    rawLevel: 0.8,
    rawSustain: 0.3,
    readyMix: 0.75,
    playbackSeconds: 14,
    sampleSeconds: 13.9,
    delayMs: 100,
    playing: true,
    seeking: false,
    canHighlight: true,
    reason: 'ready',
    ...overrides,
  }
}
function beat(overrides: Partial<BeatDebugSnapshot> = {}): BeatDebugSnapshot {
  return {
    source: privateUrl,
    mode: 'basic',
    current: sample(),
    history: [sample({ sampledAtMs: 900, level: 0.1 }), sample()],
    ...overrides,
  }
}
function task(overrides: Partial<BeatDebugQueueItem> = {}): BeatDebugQueueItem {
  return {
    source: privateUrl,
    title: '当前歌曲',
    role: 'current',
    order: null,
    reason: '缓冲够用',
    phase: 'buffered',
    progress: 0.5,
    continuousCoverageSeconds: 40,
    targetBufferSeconds: 60,
    cached: true,
    resumable: true,
    completedWindows: 2,
    estimatedWorkMs: 5000,
    completedRanges: [{ startSeconds: 0, endSeconds: 48 }],
    ...overrides,
  }
}
function scheduler(overrides: Partial<BeatSchedulerDebug> = {}): BeatSchedulerDebug {
  return {
    sampledAtMs: 1000,
    source: privateUrl,
    mode: 'basic',
    playback: { timeSeconds: 14, playing: true, playbackRate: 1, seeking: false },
    enabled: true,
    preloadEnabled: true,
    started: true,
    refilling: false,
    decision: '本曲缓冲够用，准备下一首',
    continuousCoverageSeconds: 40,
    lowWatermarkSeconds: 30,
    highWatermarkSeconds: 60,
    cacheEntries: 2,
    activeTask: null,
    queue: [],
    ...overrides,
  }
}
function slot(overrides: Partial<AudioPreloadDebug> = {}): AudioPreloadDebug {
  return {
    direction: 'next',
    channelId: 'channel-2',
    trackId: 'next',
    title: '下一首歌曲',
    artist: '歌手',
    phase: 'loading',
    currentTimeSeconds: 0,
    durationSeconds: 180,
    canStart: false,
    failed: false,
    bufferedRanges: [{ startSeconds: 0, endSeconds: 25 }],
    readyState: 1,
    networkState: 2,
    error: null,
    ...overrides,
  }
}
function track(index: number): Track {
  return {
    id: `track-${index}`,
    title: `歌曲 ${index}`,
    artist: `歌手 ${index}`,
    audioUrl: privateUrl,
    kind: 'remote',
  }
}
function panel(overrides: Partial<InstanceType<typeof PlayerDebugPanel>['$props']> = {}) {
  return mount(PlayerDebugPanel, {
    props: {
      beat: null,
      scheduler: null,
      build: { phase: 'idle', progress: 0, error: null },
      preload: [],
      queue: [],
      currentTrackId: null,
      playbackSeconds: 0,
      durationSeconds: 0,
      playing: false,
      brightness: 0.8,
      playModeText: '顺序播放',
      ...overrides,
    },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('PlayerDebugPanel', () => {
  it('distinguishes a cache-only build and bounded feature memory from playback timing', () => {
    const wrapper = panel({
      scheduler: scheduler({
        metrics: {
          totalMs: 43,
          initializationMs: 0,
          inferenceMs: 0,
          sessionReused: false,
          cacheOrigin: 'persistent',
          cacheOnly: true,
          cacheReadyMs: 41,
          cacheReadMs: 4,
          decodeMs: 0,
          modelPreparationMs: 0,
          fetchMs: 30,
          hashMs: 5,
          featureResidentBytes: 819200,
          featurePeakResidentBytes: 820800,
          featureInputBytes: 768000,
        },
      }),
    })
    const details = wrapper.get('[aria-label="最近一轮构建耗时"]')
    expect(details.text()).toContain('本地持久缓存 · 直接恢复结果')
    expect(details.text()).toContain('41 ms')
    expect(details.text()).toContain('0.78 / 0.78 MiB')
    expect(details.text()).toContain('0.73 MiB')
    expect(details.text()).toContain('并行阶段耗时不能相加')
    expect(details.text()).not.toContain(privateUrl)
    wrapper.unmount()
  })

  it('distinguishes provisional output from completed model coverage and measured timing', async () => {
    const timing: NonNullable<BeatDebugSample['timing']> = {
      clockSource: 'output-timestamp',
      frameLeadMs: 8,
      outputOffsetMs: 45,
      timelineSource: 'provisional',
      firstAvailableMs: 340,
      lastWriteAtMs: 998,
      handoffPending: true,
    }
    const wrapper = panel({
      beat: beat({ mode: 'beat-this-small', current: sample({ timing }) }),
      build: { phase: 'analysing', progress: 0, error: null, completedRanges: [] },
      playbackSeconds: 14,
      durationSeconds: 180,
    })
    expect(wrapper.get('[data-testid="timing-source"]').text()).toBe('临时基础高亮')
    expect(wrapper.text()).toContain('等待当前脉冲结束')
    expect(wrapper.text()).toContain('音频输出时钟映射')
    expect(wrapper.text()).toContain('2.0 ms')
    expect(wrapper.text()).toContain('不代表屏幕实际显示时间')
    expect(wrapper.findAll('.debug-range-completed')).toHaveLength(0)
    await wrapper.setProps({
      beat: beat({
        mode: 'beat-this-small',
        current: sample({
          timing: { ...timing, timelineSource: 'model', handoffPending: false },
        }),
      }),
    })
    expect(wrapper.get('[data-testid="timing-source"]').text()).toBe('模型分析')
    expect(wrapper.text()).toContain('已接管')
    wrapper.unmount()
  })

  it('shows honest empty states and emits close without requiring player state', async () => {
    const wrapper = panel()
    expect(wrapper.text()).toContain('等待实际输出样本')
    expect(wrapper.text()).toContain('尚无采样记录')
    expect(wrapper.get('[data-testid="level-value"]').text()).toBe('—')
    expect(wrapper.get('[data-testid="level-curve"]').attributes('d')).toBe('')
    await wrapper.get('[role="tab"][aria-controls$="preload"]').trigger('click')
    expect(wrapper.text()).toContain('等待调度快照，不推测后续任务顺序')
    expect(wrapper.text()).toContain('播放队列为空')
    await wrapper.get('button[aria-label="关闭调试面板"]').trigger('click')
    expect(wrapper.emitted('close')).toEqual([[]])
  })

  it('freezes only the curve while real levels update, then resumes actual samples', async () => {
    const wrapper = panel({ beat: beat() })
    const oldPath = wrapper.get('[data-testid="level-curve"]').attributes('d')
    expect(oldPath).toContain('L')
    expect(oldPath).not.toBe(wrapper.get('[data-testid="sustain-curve"]').attributes('d'))
    await wrapper.get('button[aria-pressed="false"]').trigger('click')
    const changed = sample({ level: 0.9, sampledAtMs: 1100 })
    await wrapper.setProps({ beat: beat({ current: changed, history: [sample(), changed] }) })
    expect(wrapper.get('[data-testid="level-value"]').text()).toBe('0.900')
    expect(wrapper.get('[data-testid="level-curve"]').attributes('d')).toBe(oldPath)
    await wrapper.get('button[aria-pressed="true"]').trigger('click')
    expect(wrapper.get('[data-testid="level-curve"]').attributes('d')).not.toBe(oldPath)
    await wrapper.get('button[aria-pressed="false"]').trigger('click')
    await wrapper.setProps({ beat: beat({ source: '/different-song.mp3' }) })
    expect(wrapper.get('[data-testid="level-curve"]').attributes('d')).toBe('')
  })

  it('honors reduced motion and lets the user explicitly resume the curve', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    )
    const wrapper = panel({ beat: beat() })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('已按系统的减少动态效果设置暂停曲线')
    await wrapper.get('button[aria-pressed="true"]').trigger('click')
    expect(wrapper.get('button[aria-pressed="false"]').text()).toContain('冻结曲线')
  })

  it('does not join missing curve samples or plot nonfinite values', () => {
    const wrapper = panel({
      beat: beat({
        history: [
          sample(),
          sample({ sampledAtMs: 2000 }),
          sample({ sampledAtMs: 2100, level: NaN }),
          sample({ sampledAtMs: 2200 }),
        ],
      }),
    })
    const path = wrapper.get('[data-testid="level-curve"]').attributes('d')
    expect(path).not.toContain('NaN')
    expect(path).not.toContain('L')
    expect(path?.match(/M/g)).toHaveLength(3)
  })

  it('preserves analysis holes and active ranges instead of inventing a ready prefix', async () => {
    const wrapper = panel({
      playbackSeconds: 25,
      durationSeconds: 100,
      build: {
        phase: 'analysing',
        progress: 0.4,
        error: null,
        availableSeconds: 40,
        completedRanges: [
          { startSeconds: 0, endSeconds: 20 },
          { startSeconds: 40, endSeconds: 60 },
        ],
        activeRange: { startSeconds: 20, endSeconds: 40 },
      },
    })
    expect(wrapper.get('[data-testid="coverage-status"]').text()).toBe('当前位置未覆盖')
    expect(wrapper.findAll('.debug-range-completed')).toHaveLength(2)
    expect(wrapper.get('.debug-range-active').attributes('style')).toContain('left: 20%')
    expect(wrapper.get('.debug-timeline').attributes('aria-label')).toContain(
      '已构建 0:00–0:20、0:40–1:00',
    )
    await wrapper.setProps({ playbackSeconds: 40.5 })
    expect(wrapper.get('[data-testid="coverage-status"]').text()).toContain('0:19')
    await wrapper.setProps({
      build: { phase: 'buffered', progress: 0.4, error: null, availableSeconds: 40 },
    })
    expect(wrapper.get('[data-testid="coverage-status"]').text()).toContain('尚未获取已构建区间')
    expect(wrapper.findAll('.debug-range-completed')).toHaveLength(0)
  })

  it('shows actual scheduler order and reasons while keeping source URLs and errors private', async () => {
    const wrapper = panel({
      scheduler: scheduler({
        decision: `读取失败 ${privateUrl} token=another-secret`,
        activeTask: {
          source: privateUrl,
          role: 'next',
          phase: 'analysing',
          progress: 0.1,
          yielding: true,
          aborted: false,
        },
        queue: [
          task(),
          task({ role: 'previous', title: '前曲', order: 1, reason: '等待下一首完成' }),
          task({ role: 'next', title: '后曲', order: 0, reason: '正在准备开头' }),
        ],
      }),
      build: { phase: 'error', progress: 0, error: privateUrl },
      beat: beat(),
    })
    await wrapper.get('[role="tab"][aria-controls$="preload"]').trigger('click')
    const tasks = wrapper.findAll('.debug-task')
    expect(tasks.map((row) => row.find('strong').text())).toEqual(['下一首', '上一首', '本曲'])
    expect(tasks[2]?.text()).toContain('缓冲够用')
    expect(wrapper.text()).toContain('正在让出')
    expect(wrapper.html()).not.toContain('private-token')
    expect(wrapper.html()).not.toContain('another-secret')
    expect(wrapper.html()).not.toContain('media.example')
  })

  it('separates ready, protected, and failed media slots with native buffer details', async () => {
    const wrapper = panel({
      preload: [
        slot({ direction: 'next', phase: 'error', failed: true, error: privateUrl }),
        slot({
          direction: 'previous',
          phase: 'protected',
          canStart: true,
          readyState: 4,
          networkState: 1,
        }),
      ],
    })
    await wrapper.get('[role="tab"][aria-controls$="preload"]').trigger('click')
    const rows = wrapper.findAll('.debug-slot')
    expect(rows[0]?.attributes('data-direction')).toBe('previous')
    expect(rows[0]?.text()).toContain('保留中 · 淡出或回退')
    expect(rows[0]?.text()).toContain('4 · 数据充足 · 可启动')
    expect(rows[0]?.text()).toContain('0:00–0:25')
    expect(rows[1]?.text()).toContain('加载失败')
    expect(wrapper.html()).not.toContain('private-token')
  })

  it('bounds long queue rendering, locates the current song, and clamps pages after removal', async () => {
    const queue = Array.from({ length: 95 }, (_, index) => track(index))
    const wrapper = panel({ queue, currentTrackId: 'track-84', playModeText: '随机播放' })
    await wrapper.get('[role="tab"][aria-controls$="preload"]').trigger('click')
    expect(wrapper.findAll('.debug-queue-row')).toHaveLength(40)
    expect(wrapper.text()).toContain('随机播放 · 下列为播放队列顺序')
    expect(wrapper.html()).not.toContain('private-token')
    await wrapper.get('button[aria-label="下一页歌曲"]').trigger('click')
    expect(wrapper.get('.debug-queue-index').text()).toBe('41')
    const locate = wrapper.findAll('button').find((button) => button.text().includes('定位当前'))
    await locate?.trigger('click')
    expect(wrapper.findAll('.debug-queue-row')).toHaveLength(15)
    expect(wrapper.get('[aria-current="true"]').text()).toContain('歌曲 84')
    expect(wrapper.get('button[aria-label="下一页歌曲"]').attributes('disabled')).toBeDefined()
    await wrapper.setProps({ queue: [track(0)], currentTrackId: 'track-0' })
    expect(wrapper.findAll('.debug-queue-row')).toHaveLength(1)
    expect(wrapper.get('.debug-queue-index').text()).toBe('1')
    expect(wrapper.find('.debug-pagination').exists()).toBe(false)
  })

  it('renders one diagnostic group at a time and preserves curve and queue controls across tabs', async () => {
    const wrapper = panel({
      beat: beat(),
      queue: Array.from({ length: 95 }, (_, index) => track(index)),
    })
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(5)
    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toBe('节拍')
    expect(wrapper.findAll('[role="tabpanel"]')).toHaveLength(1)
    expect(wrapper.find('.debug-task-list').exists()).toBe(false)
    expect(wrapper.find('.debug-queue').exists()).toBe(false)
    await wrapper.get('button[aria-pressed="false"]').trigger('click')
    await wrapper.get('[role="tab"][aria-controls$="preload"]').trigger('click')
    await wrapper.get('button[aria-label="下一页歌曲"]').trigger('click')
    await wrapper.get('[role="tab"][aria-controls$="lyrics"]').trigger('click')
    expect(wrapper.text()).toContain('尚无歌词诊断数据')
    expect(wrapper.find('.debug-queue').exists()).toBe(false)
    await wrapper.get('[role="tab"][aria-controls$="beat"]').trigger('click')
    expect(wrapper.get('button[aria-pressed="true"]').text()).toContain('恢复曲线')
    await wrapper.get('[role="tab"][aria-controls$="preload"]').trigger('click')
    expect(wrapper.get('.debug-queue-index').text()).toBe('41')
  })

  it('supports roving tab focus, arrow wrap, Home and End with associated panels', async () => {
    const wrapper = panel()
    document.body.append(wrapper.element)
    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs.map((tab) => tab.attributes('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1'])
    await tabs[0]!.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toBe('运行')
    expect(document.activeElement).toBe(tabs[4]!.element)
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-labelledby')).toBe(
      tabs[4]!.attributes('id'),
    )
    await tabs[4]!.trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(tabs[0]!.element)
    await tabs[0]!.trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tabs[1]!.element)
    await tabs[1]!.trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(tabs[4]!.element)
    wrapper.unmount()
  })

  it('forwards the lyrics window click synchronously without changing debug tabs', async () => {
    const wrapper = panel({ hasCurrentTrack: true, lyricsWindowSupported: true })
    await wrapper.get('[role="tab"][aria-controls$="lyrics"]').trigger('click')
    const button = wrapper.get('.lyrics-debug-action')
    expect(button.attributes('disabled')).toBeUndefined()
    button.element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(wrapper.emitted('toggle-lyrics-window')).toEqual([[]])
    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toBe('歌词')
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('gates comparison work by its visible tab and forwards manual commands', async () => {
    const wrapper = panel({ canCompare: true, comparisonExportSampleCount: 40 })
    expect(wrapper.emitted('comparison-visible')).toEqual([[false]])
    await wrapper.get('[role="tab"][aria-controls$="comparison"]').trigger('click')
    expect(wrapper.emitted('comparison-visible')?.at(-1)).toEqual([true])
    const comparison = wrapper.findComponent({ name: 'BeatComparisonSection' })
    expect(comparison.exists()).toBe(true)
    comparison.vm.$emit('start')
    comparison.vm.$emit('stop')
    await comparison.get('.comparison-export-button').trigger('click')
    expect(wrapper.emitted('compare-start')).toEqual([[]])
    expect(wrapper.emitted('compare-stop')).toEqual([[]])
    expect(wrapper.emitted('compare-export')).toEqual([[]])
    await wrapper.get('[role="tab"][aria-controls$="beat"]').trigger('click')
    expect(wrapper.emitted('comparison-visible')?.at(-1)).toEqual([false])
    expect(wrapper.findComponent({ name: 'BeatComparisonSection' }).exists()).toBe(false)
    wrapper.unmount()
  })
})
