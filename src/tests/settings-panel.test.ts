import { mount, type DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import SettingToggleRow from '../components/SettingToggleRow.vue'
import SettingsPanel from '../components/SettingsPanel.vue'
import type { BeatBuildStatus, BeatPreloadStatus } from '../core/analysis/beat-timeline'
import type { Track } from '../core/types'
import { usePlayerStore } from '../stores/player'

const modelActions = vi.hoisted(() => ({
  initialize: vi.fn(async () => {}),
  download: vi.fn(async () => true),
  cancel: vi.fn(),
  remove: vi.fn(async () => {}),
}))
type ModelPhase = 'checking' | 'missing' | 'downloading' | 'ready' | 'error' | 'removing'
const modelStatus = ref<
  Record<'small' | 'standard', { phase: ModelPhase; progress: number; error: string | null }>
>({
  small: { phase: 'missing', progress: 0, error: null },
  standard: { phase: 'missing', progress: 0, error: null },
})

vi.mock('../platform/web/useBeatThisModels', () => ({
  useBeatThisModels: () => ({ status: modelStatus, runtimeBytes: 25_000_000, ...modelActions }),
}))
function mountPanel() {
  const store = usePlayerStore()
  const wrapper = mount(SettingsPanel, {
    props: {
      playModeText: '单曲循环',
      sleepTimer: {
        minutes: 0,
        remaining: 0,
        displayMinutes: 0,
        progress: 0,
        options: [0, 15, 30, 60],
        formatRemaining: (value: number) => `${value}`,
      },
      capabilities: {
        portableDevice: false,
        fullscreenActive: false,
        fullscreenSupported: true,
        lyricsWindowSupported: true,
        lyricsWindowOpen: false,
        hasCurrentTrack: true,
        canInstall: false,
        isInstalled: false,
        iosInstallAvailable: false,
      },
    },
  })
  return { wrapper, store }
}

/** 按分组标题定位分组;分组标题是 h3 */
function sectionByTitle(wrapper: ReturnType<typeof mountPanel>['wrapper'], title: string) {
  return wrapper.findAll('.settings-section').find((section) => section.find('h3').text() === title)
}

function analysisModeButtons(analysis: Pick<DOMWrapper<Element>, 'get'>) {
  return {
    basic: analysis.get('button[data-mode="basic"]'),
    small: analysis.get('button[data-mode="beat-this-small"]'),
    standard: analysis.get('button[data-mode="beat-this-standard"]'),
  }
}

function preloadStatus(overrides: Partial<BeatPreloadStatus> = {}): BeatPreloadStatus {
  return {
    direction: 'next',
    source: '/next.mp3',
    title: '下一首歌曲',
    phase: 'idle',
    progress: 0,
    error: null,
    ...overrides,
  }
}

describe('SettingsPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    modelStatus.value = {
      small: { phase: 'missing', progress: 0, error: null },
      standard: { phase: 'missing', progress: 0, error: null },
    }
  })

  it('keeps the optional debug panel switch in its own section', async () => {
    const { wrapper, store } = mountPanel()
    try {
      const debug = sectionByTitle(wrapper, '调试')!
      const toggle = debug.get('input[aria-label="播放器调试面板"]')
      expect((toggle.element as HTMLInputElement).checked).toBe(false)
      expect(store.settings.debugPanelEnabled).toBe(false)
      expect(sectionByTitle(wrapper, '播放')!.text()).not.toContain('调试')
      expect(sectionByTitle(wrapper, '歌词')!.text()).not.toContain('调试')
      await toggle.setValue(true)
      expect(store.settings.debugPanelEnabled).toBe(true)
      await toggle.setValue(false)
      expect(store.settings.debugPanelEnabled).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('shows the current song details and the source of the displayed lyrics', async () => {
    const { wrapper } = mountPanel()
    const track: Track = {
      id: 'song-info',
      title: '同名歌曲',
      titleVersions: ['Live', '2026'],
      artist: '歌手',
      album: '现场专辑',
      audioUrl: 'https://example.com/audio?private-token=secret',
      kind: 'meting',
    }

    await wrapper.setProps({
      songInfo: {
        track,
        duration: 245.8,
        lyricStatus: 'ready',
        lyricSource: 'netease',
        hasWordTiming: true,
      },
    })

    const songInfo = sectionByTitle(wrapper, '歌曲信息')!
    expect(songInfo.get('.song-info-title').text()).toBe('同名歌曲 (Live) (2026)')
    expect(songInfo.text()).toContain('歌手')
    expect(songInfo.text()).toContain('现场专辑')
    expect(songInfo.text()).toContain('4:05')
    expect(songInfo.text()).toContain('Meting')
    expect(songInfo.get('.song-info-lyrics').text()).toContain('网易云 YRC')
    expect(songInfo.get('.song-info-timing').text()).toBe('逐字')
    expect(songInfo.html()).not.toContain('private-token')
  })

  it('replaces the source during progressive loading and never carries it into the next song', async () => {
    const { wrapper } = mountPanel()
    const track: Track = {
      id: 'first',
      title: '第一首',
      artist: '歌手',
      audioUrl: '/first.mp3',
      kind: 'local',
    }
    const info = {
      track,
      duration: 0,
      lyricStatus: 'ready' as const,
      lyricSource: 'qq' as const,
      hasWordTiming: true,
    }
    await wrapper.setProps({ songInfo: info })
    const songInfo = sectionByTitle(wrapper, '歌曲信息')!
    expect(songInfo.get('.song-info-lyrics').text()).toContain('QQ 音乐 QRC')

    await wrapper.setProps({ songInfo: { ...info, lyricSource: 'amll' } })
    expect(songInfo.get('.song-info-lyrics').text()).toContain('AMLL 逐字歌词库')
    expect(songInfo.text()).not.toContain('QQ 音乐 QRC')

    await wrapper.setProps({
      songInfo: {
        ...info,
        track: { ...track, id: 'second', title: '第二首' },
        lyricStatus: 'loading',
      },
    })
    expect(songInfo.get('.song-info-title').text()).toBe('第二首')
    expect(
      songInfo.get('.song-info-lyric-value .song-info-placeholder').attributes('aria-hidden'),
    ).toBe('true')
    expect(songInfo.get('.song-info-lyric-value .sr-only').text()).toBe('正在加载歌词来源')
    expect(songInfo.find('.song-info-source').exists()).toBe(false)
    expect(songInfo.text()).not.toContain('QQ 音乐 QRC')
    expect(songInfo.text()).not.toContain('AMLL 逐字歌词库')
    expect(songInfo.find('.song-info-timing').exists()).toBe(false)
    expect(songInfo.get('.song-info-duration').attributes('aria-busy')).toBe('true')
  })

  it('keeps absent and unknown lyrics honest instead of inferring a provider from the song kind', async () => {
    const { wrapper } = mountPanel()
    const songInfo = sectionByTitle(wrapper, '歌曲信息')!
    expect(songInfo.text()).toContain('选择歌曲后查看歌曲和歌词来源')
    const info = {
      track: {
        id: 'local',
        title: '曲目',
        artist: '',
        audioUrl: '/song.mp3',
        kind: 'local' as const,
      },
      duration: 0,
      lyricStatus: 'ready' as const,
      lyricSource: null,
      hasWordTiming: false,
    }
    await wrapper.setProps({ songInfo: info })
    expect(songInfo.text()).toContain('本地曲库')
    expect(songInfo.get('.song-info-lyrics').text()).toContain('来源未知')
    expect(songInfo.get('.song-info-timing').text()).toBe('逐行')

    for (const [status, label] of [
      ['idle', '尚未加载'],
      ['empty', '暂无歌词'],
      ['error', '歌词加载失败'],
    ] as const) {
      await wrapper.setProps({ songInfo: { ...info, lyricStatus: status } })
      expect(songInfo.get('.song-info-lyrics').text()).toContain(label)
      expect(songInfo.find('.song-info-timing').exists()).toBe(false)
    }
  })

  it('keeps information slots mounted through loading, ready, and failed metadata', async () => {
    const { wrapper } = mountPanel()
    const track: Track = {
      id: 'stable-info',
      title: '正在加载的歌曲',
      artist: '歌手',
      audioUrl: '/song.mp3',
      kind: 'local',
    }
    const info = {
      track: null,
      loading: true,
      duration: 0,
      lyricStatus: 'loading' as const,
      lyricSource: null,
      hasWordTiming: false,
    }
    await wrapper.setProps({ songInfo: info })
    const songInfo = sectionByTitle(wrapper, '歌曲信息')!
    const content = songInfo.get('.song-info-content').element
    const rows = songInfo.findAll('.song-info-row').map((row) => row.element)
    const duration = songInfo.get('.song-info-duration').element
    const lyricValue = songInfo.get('.song-info-lyric-value').element
    expect(songInfo.get('.song-info-content').attributes('aria-busy')).toBe('true')
    expect(songInfo.text()).toContain('正在加载歌曲信息')
    expect(songInfo.find('.song-info-title .song-info-placeholder').exists()).toBe(true)

    await wrapper.setProps({ songInfo: { ...info, track, loading: false } })
    expect(songInfo.get('.song-info-title').text()).toBe(track.title)
    expect(songInfo.find('.song-info-title .song-info-placeholder').exists()).toBe(false)
    expect(songInfo.find('.song-info-duration .song-info-placeholder').exists()).toBe(true)
    expect(songInfo.find('.song-info-lyric-value .song-info-placeholder').exists()).toBe(true)
    expect(songInfo.get('.song-info-lyrics').attributes('aria-busy')).toBe('true')

    await wrapper.setProps({
      songInfo: {
        ...info,
        track: { ...track, album: '加载完成的专辑' },
        loading: false,
        duration: 245,
        lyricStatus: 'ready',
        lyricSource: 'amll',
        hasWordTiming: true,
      },
    })
    expect(songInfo.get('.song-info-content').element).toBe(content)
    expect(songInfo.findAll('.song-info-row').map((row) => row.element)).toEqual(rows)
    expect(songInfo.get('.song-info-duration').element).toBe(duration)
    expect(songInfo.get('.song-info-lyric-value').element).toBe(lyricValue)
    expect(songInfo.get('.song-info-duration').text()).toBe('4:05')
    expect(songInfo.findAll('.song-info-placeholder')).toHaveLength(0)

    await wrapper.setProps({
      songInfo: { ...info, track, loading: false, durationUnavailable: true, lyricStatus: 'error' },
    })
    expect(songInfo.get('.song-info-duration').text()).toBe('暂不可用')
    expect(songInfo.findAll('.song-info-placeholder')).toHaveLength(0)
    expect(songInfo.get('.song-info-lyrics').text()).toContain('歌词加载失败')
    expect(songInfo.findAll('.song-info-row').map((row) => row.element)).toEqual(rows)
  })

  it('collapses the background sliders that have no effect once their master toggle is off', async () => {
    const { wrapper, store } = mountPanel()
    const background = sectionByTitle(wrapper, '背景')!
    const [coverCollapse, beatCollapse] = background.findAll('.collapse-wrapper')

    expect(coverCollapse!.classes()).toContain('expanded')
    expect(beatCollapse!.classes()).toContain('expanded')

    store.settings.dynamicBackground = false
    store.settings.beatFlash = false
    await nextTick()

    expect(coverCollapse!.classes()).not.toContain('expanded')
    expect(beatCollapse!.classes()).not.toContain('expanded')
    // 收起后高度为 0 但节点还在,必须 inert 掉,否则 Tab 会停进看不见的滑块
    for (const body of background.findAll('.collapse-body')) {
      expect(body.attributes('inert')).toBeDefined()
    }
  })

  it('defaults to basic analysis and previews optional models without downloading or enabling them', async () => {
    const { wrapper, store } = mountPanel()
    const analysis = wrapper.get('.beat-analysis-settings')
    const { basic, small, standard } = analysisModeButtons(analysis)

    expect(store.settings.beatAnalysisMode).toBe('basic')
    expect(basic!.attributes('aria-pressed')).toBe('true')
    expect(small!.text()).toBe('Small')
    expect(standard!.text()).toBe('标准版')
    expect(analysis.text()).toContain('播放后优先分析当前位置，分段就绪即开始高亮')
    expect(analysis.get('[role="status"]').text()).toBe('等待播放后预分析')
    expect(modelActions.initialize).toHaveBeenCalledOnce()
    expect(modelActions.download).not.toHaveBeenCalled()
    await small!.trigger('click')
    expect(store.settings.beatAnalysisMode).toBe('basic')
    expect(analysis.get('.beat-model-card').text()).toContain('下载模型')
    expect(analysis.get('.beat-model-card').text()).toContain('首次下载另需 25.0 MB 运行组件')
    expect(modelActions.download).not.toHaveBeenCalled()
    expect(wrapper.emitted('beatBuildRetry')).toBeUndefined()
  })

  it('keeps completed downloads opt-in and never enables an abandoned selection', async () => {
    const { wrapper, store } = mountPanel()
    const analysis = wrapper.get('.beat-analysis-settings')
    const { small, standard } = analysisModeButtons(analysis)
    await small!.trigger('click')
    await analysis.get('.beat-model-card .beat-analysis-action').trigger('click')
    expect(modelActions.download).toHaveBeenCalledWith('small')
    modelStatus.value.small = { phase: 'downloading', progress: 0.4, error: null }
    await nextTick()
    expect(analysis.get('[aria-label="模型下载进度"]').attributes('aria-valuenow')).toBe('40')
    await standard!.trigger('click')
    expect(analysis.get('.beat-model-card button').attributes('disabled')).toBeDefined()
    expect(analysis.get('.beat-model-card').text()).toContain('另一个模型正在下载')
    modelStatus.value.small = { phase: 'ready', progress: 1, error: null }
    await nextTick()
    expect(store.settings.beatAnalysisMode).toBe('basic')
    expect(analysis.get('.beat-model-card').text()).toContain('更完整的模型')
    await small!.trigger('click')
    expect(store.settings.beatAnalysisMode).toBe('beat-this-small')
    expect(modelActions.download).toHaveBeenCalledTimes(1)
  })

  it('requires explicit enable after a download and lets either cached model be selected', async () => {
    const { wrapper, store } = mountPanel()
    const analysis = wrapper.get('.beat-analysis-settings')
    const { basic, small, standard } = analysisModeButtons(analysis)
    await small!.trigger('click')
    await analysis.get('.beat-model-card .beat-analysis-action').trigger('click')
    modelStatus.value.small = { phase: 'ready', progress: 1, error: null }
    await nextTick()
    expect(store.settings.beatAnalysisMode).toBe('basic')
    const enable = analysis
      .findAll('.beat-model-card button')
      .find((button) => button.text() === '启用模型')!
    await enable.trigger('click')
    expect(store.settings.beatAnalysisMode).toBe('beat-this-small')
    modelStatus.value.standard = { phase: 'ready', progress: 1, error: null }
    await standard!.trigger('click')
    expect(store.settings.beatAnalysisMode).toBe('beat-this-standard')
    await basic!.trigger('click')
    expect(store.settings.beatAnalysisMode).toBe('basic')
  })

  it('allows cancelling, retrying and deleting an optional model without silent downloads', async () => {
    const { wrapper, store } = mountPanel()
    const analysis = wrapper.get('.beat-analysis-settings')
    const { small } = analysisModeButtons(analysis)
    modelStatus.value.small = { phase: 'downloading', progress: 0.2, error: null }
    await small.trigger('click')
    await analysis.get('.beat-model-card button').trigger('click')
    expect(modelActions.cancel).toHaveBeenCalledWith('small')
    modelStatus.value.small = { phase: 'error', progress: 0, error: '网络连接中断' }
    await nextTick()
    expect(analysis.get('.beat-model-status').text()).toBe('网络连接中断')
    expect(modelActions.download).not.toHaveBeenCalled()
    await analysis.get('.beat-model-card button').trigger('click')
    expect(modelActions.download).toHaveBeenCalledWith('small')
    modelStatus.value.small = { phase: 'ready', progress: 1, error: null }
    await small.trigger('click')
    expect(store.settings.beatAnalysisMode).toBe('beat-this-small')
    const remove = analysis
      .findAll('.beat-model-card button')
      .find((button) => button.text() === '删除模型')!
    await remove.trigger('click')
    expect(store.settings.beatAnalysisMode).toBe('basic')
    expect(modelActions.remove).toHaveBeenCalledWith('small')
  })

  it('exposes build progress independently of optional model downloads', async () => {
    const { wrapper, store } = mountPanel()
    const status: BeatBuildStatus = {
      phase: 'analysing',
      progress: 0.5,
      error: null,
    }
    await wrapper.setProps({ beatBuild: status })
    const analysis = wrapper.get('.beat-analysis-settings')
    const progress = analysis.get('[role="progressbar"]')

    expect(progress.attributes('aria-valuenow')).toBe('50')
    expect(analysis.get('[role="status"]').text()).toBe('正在构建节奏 · 50%')
    expect(analysis.get('.beat-analysis-feedback').attributes('aria-busy')).toBe('true')
    expect(analysis.find('.beat-analysis-action').exists()).toBe(false)
    expect(store.settings.beatAnalysisMode).toBe('basic')
  })

  it('places a completed middle section at its actual position instead of filling a prefix', async () => {
    const { wrapper } = mountPanel()
    await wrapper.setProps({
      beatBuild: {
        phase: 'analysing',
        progress: 0.6,
        availableSeconds: 30,
        durationSeconds: 300,
        completedRanges: [{ startSeconds: 60, endSeconds: 90 }],
        activeRange: { startSeconds: 90, endSeconds: 120 },
        playbackSeconds: 75,
        error: null,
      },
    })
    const analysis = wrapper.get('.beat-analysis-feedback')
    expect(analysis.get('[role="status"]').text()).toBe('已完成 0:30 / 5:00 · 10%')
    expect(analysis.get('.beat-analysis-position').text()).toBe('当前位置已就绪 · 可连续高亮 0:15')
    expect(analysis.get('.beat-analysis-position').attributes('aria-live')).toBe('off')
    expect(analysis.text()).toContain('根据播放位置与分析速度，优先准备即将播放的部分')
    expect(analysis.attributes('aria-busy')).toBe('true')
    expect(analysis.find('.beat-analysis-spinner').exists()).toBe(true)
    expect(analysis.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('10')
    expect(analysis.get('[role="progressbar"]').attributes('aria-valuetext')).toContain(
      '可高亮区间 1:00 至 1:30',
    )
    const completed = analysis.findAll('.beat-analysis-completed-range')
    expect(completed).toHaveLength(1)
    expect((completed[0]!.element as HTMLElement).style.left).toBe('20%')
    expect((completed[0]!.element as HTMLElement).style.width).toBe('10%')
    const active = analysis.get('.beat-analysis-active-range').element as HTMLElement
    expect(active.style.left).toBe('30%')
    expect(active.style.width).toBe('10%')
    expect((analysis.get('.beat-analysis-playhead').element as HTMLElement).style.left).toBe('25%')
    expect(analysis.find('.beat-analysis-progress').exists()).toBe(false)
    expect(analysis.text()).not.toContain('已分析至')
  })

  it('preserves multiple uncovered gaps and moves the active range after a seek', async () => {
    const { wrapper, store } = mountPanel()
    const track: Track = {
      id: 'timeline',
      title: '曲目',
      artist: '歌手',
      audioUrl: '/song.mp3',
      kind: 'local',
    }
    store.setTracks([track])
    store.selectTrack(track)
    store.currentTime = 150
    const status: BeatBuildStatus = {
      phase: 'analysing',
      progress: 0.9,
      availableSeconds: 90,
      durationSeconds: 300,
      completedRanges: [
        { startSeconds: 0, endSeconds: 30 },
        { startSeconds: 60, endSeconds: 90 },
        { startSeconds: 240, endSeconds: 270 },
      ],
      activeRange: { startSeconds: 150, endSeconds: 180 },
      playbackSeconds: 75,
      error: null,
    }
    await wrapper.setProps({ beatBuild: status })
    const analysis = wrapper.get('.beat-analysis-feedback')
    expect(
      analysis.findAll('.beat-analysis-completed-range').map((segment) => {
        const style = (segment.element as HTMLElement).style
        return { left: style.left, width: style.width }
      }),
    ).toEqual([
      { left: '0%', width: '10%' },
      { left: '20%', width: '10%' },
      { left: '80%', width: '10%' },
    ])
    expect(analysis.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('30')
    expect(analysis.get('.beat-analysis-position').text()).toBe('正在优先准备当前位置')
    expect((analysis.get('.beat-analysis-playhead').element as HTMLElement).style.left).toBe('50%')
    store.currentTime = 285
    await wrapper.setProps({
      beatBuild: {
        ...status,
        activeRange: { startSeconds: 270, endSeconds: 300 },
      },
    })
    expect((analysis.get('.beat-analysis-active-range').element as HTMLElement).style.left).toBe(
      '90%',
    )
    expect((analysis.get('.beat-analysis-playhead').element as HTMLElement).style.left).toBe('95%')
    expect(analysis.findAll('.beat-analysis-completed-range')).toHaveLength(3)
    expect(analysis.get('[role="progressbar"]').attributes('aria-valuetext')).toContain(
      '正在分析 4:30 至 5:00；播放位置 4:45',
    )
  })

  it('never guesses completed positions from the total completed duration', async () => {
    const { wrapper } = mountPanel()
    await wrapper.setProps({
      beatBuild: {
        phase: 'analysing',
        progress: 0.5,
        availableSeconds: 60,
        durationSeconds: 300,
        error: null,
      },
    })
    const analysis = wrapper.get('.beat-analysis-feedback')
    expect(analysis.findAll('.beat-analysis-completed-range')).toHaveLength(0)
    expect(analysis.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('20')
    expect(analysis.get('.beat-analysis-position').text()).toBe('当前位置尚未就绪')
  })

  it('reports no continuous coverage inside a hole even when most of the song is complete', async () => {
    const { wrapper } = mountPanel()
    const status: BeatBuildStatus = {
      phase: 'analysing',
      progress: 0.9,
      availableSeconds: 270,
      durationSeconds: 300,
      completedRanges: [
        { startSeconds: 0, endSeconds: 90 },
        { startSeconds: 120, endSeconds: 300 },
      ],
      activeRange: { startSeconds: 90, endSeconds: 120 },
      playbackSeconds: 90,
      error: null,
    }
    await wrapper.setProps({ beatBuild: status })
    const analysis = wrapper.get('.beat-analysis-feedback')
    expect(analysis.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('90')
    expect(analysis.get('.beat-analysis-position').text()).toBe('正在优先准备当前位置')
    await wrapper.setProps({ beatBuild: { ...status, playbackSeconds: 100 } })
    expect(analysis.get('.beat-analysis-position').text()).toBe('正在优先准备当前位置')
    await wrapper.setProps({ beatBuild: { ...status, playbackSeconds: 120 } })
    expect(analysis.get('.beat-analysis-position').text()).toBe('当前位置已就绪 · 可连续高亮 3:00')
  })

  it('distinguishes preparing a future range from work that covers the current position', async () => {
    const { wrapper } = mountPanel()
    const status: BeatBuildStatus = {
      phase: 'analysing',
      progress: 0,
      availableSeconds: 0,
      durationSeconds: 300,
      completedRanges: [],
      playbackSeconds: 100,
      activeRange: { startSeconds: 120, endSeconds: 144 },
      error: null,
    }
    await wrapper.setProps({ beatBuild: status })
    const position = wrapper.get('.beat-analysis-position')
    expect(position.text()).toBe('正在提前准备后续区间')
    await wrapper.setProps({
      beatBuild: { ...status, activeRange: { startSeconds: 96, endSeconds: 120 } },
    })
    expect(position.text()).toBe('正在优先准备当前位置')
    await wrapper.setProps({
      beatBuild: { ...status, activeRange: { startSeconds: 72, endSeconds: 96 } },
    })
    expect(position.text()).toBe('当前位置尚未就绪')
    await wrapper.setProps({ beatBuild: { ...status, activeRange: undefined } })
    expect(position.text()).toBe('当前位置尚未就绪')
  })

  it('keeps local readiness while paused and does not put the countdown in a live announcement', async () => {
    const { wrapper, store } = mountPanel()
    const track: Track = {
      id: 'paused-coverage',
      title: '曲目',
      artist: '歌手',
      audioUrl: '/song.mp3',
      kind: 'local',
    }
    store.setTracks([track])
    store.selectTrack(track)
    store.currentTime = 108
    store.isPlaying = true
    await wrapper.setProps({
      beatBuild: {
        phase: 'analysing',
        progress: 0.4,
        availableSeconds: 120,
        durationSeconds: 300,
        completedRanges: [{ startSeconds: 60, endSeconds: 180 }],
        error: null,
      },
    })
    const analysis = wrapper.get('.beat-analysis-feedback')
    const announcement = analysis.get('[role="status"]').text()
    expect(analysis.get('.beat-analysis-position').text()).toBe('当前位置已就绪 · 可连续高亮 1:12')
    store.isPlaying = false
    await nextTick()
    expect(analysis.get('.beat-analysis-position').text()).toBe('当前位置已就绪 · 可连续高亮 1:12')
    store.currentTime = 109.1
    await nextTick()
    expect(analysis.get('.beat-analysis-position').text()).toBe('当前位置已就绪 · 可连续高亮 1:10')
    store.currentTime = 109.9
    await nextTick()
    expect(analysis.get('.beat-analysis-position').text()).toBe('当前位置已就绪 · 可连续高亮 1:10')
    expect(analysis.get('.beat-analysis-position').attributes('aria-live')).toBe('off')
    expect(analysis.get('[role="status"]').text()).toBe(announcement)
    store.currentTime = 179.5
    await nextTick()
    expect(analysis.get('.beat-analysis-position').text()).toBe(
      '当前位置已就绪 · 可连续高亮 不足 1 秒',
    )
  })

  it('keeps a complete timeline visible and removes the active analysis marker when ready', async () => {
    const { wrapper } = mountPanel()
    await wrapper.setProps({
      beatBuild: {
        phase: 'ready',
        progress: 1,
        durationSeconds: 300,
        activeRange: { startSeconds: 270, endSeconds: 300 },
        error: null,
      },
    })
    const analysis = wrapper.get('.beat-analysis-feedback')
    expect(analysis.attributes('aria-busy')).toBe('false')
    expect(analysis.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('100')
    expect(
      (analysis.get('.beat-analysis-completed-range').element as HTMLElement).style.width,
    ).toBe('100%')
    expect(analysis.find('.beat-analysis-spinner').exists()).toBe(false)
    expect(analysis.find('.beat-analysis-active-range').exists()).toBe(false)
    expect(analysis.text()).toContain('无需重新分析')
    expect(analysis.get('.beat-analysis-position').text()).toBe('当前位置已就绪 · 可连续高亮 5:00')
    await wrapper.setProps({
      beatBuild: {
        phase: 'ready',
        progress: 1,
        durationSeconds: 300,
        playbackSeconds: 300,
        error: null,
      },
    })
    expect(analysis.get('.beat-analysis-position').text()).toBe('已到歌曲结尾')
  })

  it('shows a parked partial buffer without implying the whole song is complete', async () => {
    const { wrapper, store } = mountPanel()
    store.isPlaying = true
    const status: BeatBuildStatus = {
      phase: 'buffered',
      progress: 1,
      availableSeconds: 300,
      durationSeconds: 300,
      completedRanges: [{ startSeconds: 60, endSeconds: 120 }],
      playbackSeconds: 75,
      activeRange: { startSeconds: 120, endSeconds: 144 },
      error: null,
    }
    await wrapper.setProps({ beatBuild: status })
    const analysis = wrapper.get('.beat-analysis-feedback')
    const rail = analysis.get('.beat-analysis-timeline').element
    expect(analysis.get('[role="status"]').text()).toBe('已缓冲 1:00 / 5:00 · 20%')
    expect(analysis.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('20')
    expect(analysis.get('.beat-analysis-position').text()).toBe('当前位置已就绪 · 可连续高亮 0:45')
    expect(analysis.text()).toContain('接近已准备区间末端时自动续建')
    expect(analysis.text()).not.toContain('预分析已完成')
    expect(analysis.attributes('aria-busy')).toBe('false')
    expect(analysis.find('.beat-analysis-spinner').exists()).toBe(false)
    expect(analysis.find('.beat-analysis-active-range').exists()).toBe(false)
    store.isPlaying = false
    await nextTick()
    expect(analysis.text()).toContain('已保留分析结果，继续播放后按需续建')
    expect(analysis.get('.beat-analysis-timeline').element).toBe(rail)
    await wrapper.setProps({ beatBuild: { ...status, phase: 'analysing', playbackSeconds: 105 } })
    expect(analysis.get('.beat-analysis-timeline').element).toBe(rail)
    expect(analysis.find('.beat-analysis-active-range').exists()).toBe(true)
    expect(analysis.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('20')
  })

  it('keeps known buffered ranges visible while preparing to resume analysis', async () => {
    const { wrapper } = mountPanel()
    const status: BeatBuildStatus = {
      phase: 'buffered',
      progress: 0.2,
      durationSeconds: 300,
      error: null,
      completedRanges: [{ startSeconds: 60, endSeconds: 120 }],
      playbackSeconds: 75,
    }
    await wrapper.setProps({ beatBuild: status })
    const rail = wrapper.get('.beat-analysis-timeline').element
    for (const phase of ['loading-model', 'fetching', 'decoding'] as const) {
      await wrapper.setProps({ beatBuild: { ...status, phase } })
      expect(wrapper.get('.beat-analysis-timeline').element).toBe(rail)
      expect(wrapper.get('.beat-analysis-completed-range').attributes('style')).toContain(
        'left: 20%',
      )
      expect(wrapper.get('.beat-analysis-position').text()).toContain('可连续高亮 0:45')
    }
  })

  it('retains completed ranges on failure but stops presenting the stale active range as running', async () => {
    const { wrapper } = mountPanel()
    await wrapper.setProps({
      beatBuild: {
        phase: 'error',
        progress: 0.4,
        durationSeconds: 300,
        availableSeconds: 30,
        completedRanges: [{ startSeconds: 60, endSeconds: 90 }],
        activeRange: { startSeconds: 90, endSeconds: 120 },
        error: '分析已停止，请重试',
      },
    })
    const analysis = wrapper.get('.beat-analysis-feedback')
    expect(analysis.findAll('.beat-analysis-completed-range')).toHaveLength(1)
    expect(analysis.find('.beat-analysis-active-range').exists()).toBe(false)
    expect(analysis.attributes('aria-busy')).toBe('false')
    expect(analysis.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('10')
    expect(analysis.text()).toContain('分析已停止，请重试')
    expect(analysis.get('.beat-analysis-position').text()).toBe('当前位置尚未就绪')
    await wrapper.setProps({ beatBuild: { ...wrapper.props('beatBuild')!, playbackSeconds: 75 } })
    expect(analysis.get('.beat-analysis-position').text()).toBe('当前位置已就绪 · 可连续高亮 0:15')
    expect(analysis.text()).toContain('分析已停止，请重试')
    await wrapper.get('.beat-analysis-settings .beat-analysis-action').trigger('click')
    expect(wrapper.emitted('beatBuildRetry')).toEqual([[]])
  })

  it('uses indeterminate decoding feedback and announces complete timelines', async () => {
    const { wrapper } = mountPanel()
    await wrapper.setProps({ beatBuild: { phase: 'decoding', progress: 0, error: null } })
    const analysis = wrapper.get('.beat-analysis-settings')
    expect(analysis.get('[role="progressbar"]').classes()).toContain('indeterminate')
    expect(analysis.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined()
    expect(analysis.get('[role="status"]').text()).toBe('正在解码音频')
    expect(analysis.text()).toContain('正在准备音频，当前位置就绪后开始高亮')
    await wrapper.setProps({
      beatBuild: { phase: 'fetching', progress: 0.5, durationSeconds: 300, error: null },
    })
    expect(analysis.get('[role="progressbar"]').classes()).toContain('indeterminate')
    expect(analysis.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined()
    expect(analysis.find('.beat-analysis-timeline').exists()).toBe(false)
    await wrapper.setProps({ beatBuild: { phase: 'loading-model', progress: 0, error: null } })
    expect(analysis.get('[role="progressbar"]').classes()).toContain('indeterminate')
    expect(analysis.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined()
    expect(analysis.get('[role="status"]').text()).toBe('正在加载本机模型')
    await wrapper.setProps({ beatBuild: { phase: 'ready', progress: 1, error: null } })
    expect(analysis.get('[role="status"]').text()).toContain('预分析已完成')
    expect(analysis.get('.beat-analysis-feedback').attributes('aria-busy')).toBe('false')
    expect(analysis.find('[role="progressbar"]').exists()).toBe(false)
    expect(analysis.text()).toContain('无需重新分析')
  })

  it('reports failed preanalysis and delegates only the explicit retry', async () => {
    const { wrapper } = mountPanel()
    await wrapper.setProps({
      beatBuild: { phase: 'error', progress: 0, error: '音源暂时无法读取，播放不受影响' },
    })
    const analysis = wrapper.get('.beat-analysis-settings')
    expect(analysis.get('[role="status"]').text()).toBe('本曲预分析未完成')
    expect(analysis.text()).toContain('音源暂时无法读取，播放不受影响')
    expect(wrapper.emitted('beatBuildRetry')).toBeUndefined()
    await analysis.get('.beat-analysis-action').trigger('click')
    expect(wrapper.emitted('beatBuildRetry')).toEqual([[]])
    expect(analysis.findAll('.beat-analysis-action')).toHaveLength(1)
  })

  it('only shows adjacent analysis targets while the existing preload setting is enabled', async () => {
    const { wrapper, store } = mountPanel()
    expect(wrapper.find('.beat-preload-list').exists()).toBe(false)
    const status: BeatBuildStatus = { phase: 'ready', progress: 1, error: null, adjacent: [] }
    await wrapper.setProps({ beatBuild: status })
    expect(wrapper.find('.beat-preload-list').exists()).toBe(false)
    await wrapper.setProps({ beatBuild: { ...status, adjacent: [preloadStatus()] } })
    expect(wrapper.findAll('.beat-preload-row')).toHaveLength(1)
    expect(wrapper.get('.beat-preload-list').text()).toContain('下一首')
    expect(wrapper.get('.beat-preload-list').text()).not.toContain('上一首')
    store.settings.preloadNextTrack = false
    await nextTick()
    expect(wrapper.find('.beat-preload-list').exists()).toBe(false)
    store.settings.preloadNextTrack = true
    await nextTick()
    expect(wrapper.find('.beat-preload-list').exists()).toBe(true)
    await wrapper.setProps({ beatBuild: { ...status, adjacent: undefined } })
    expect(wrapper.find('.beat-preload-list').exists()).toBe(false)
  })

  it('orders previous and next consistently and keeps background progress separate from the current song', async () => {
    const { wrapper } = mountPanel()
    const longTitle = '这是一首名称很长的歌曲（完整现场录音版本）'
    const previous = preloadStatus({
      direction: 'previous',
      source: '/previous.mp3?token=private-preload-token',
      title: longTitle,
      phase: 'idle',
    })
    const next = preloadStatus({ phase: 'analysing', progress: 0.5, availableSeconds: 23.75 })
    const status: BeatBuildStatus = {
      phase: 'ready',
      progress: 1,
      durationSeconds: 180,
      error: null,
      adjacent: [next, previous],
    }
    await wrapper.setProps({ beatBuild: status })
    const feedback = wrapper.get('.beat-analysis-feedback')
    const before = feedback.html()
    const list = wrapper.get('.beat-preload-list')
    const rows = list.findAll('.beat-preload-row')
    expect(rows.map((row) => row.get('.beat-preload-direction').text())).toEqual([
      '上一首',
      '下一首',
    ])
    expect(rows[0]!.get('.beat-preload-title').attributes('title')).toBe(longTitle)
    expect(rows[0]!.get('.beat-preload-label').text()).toBe('等待预分析')
    expect(rows[1]!.get('.beat-preload-label').text()).toBe('已备好 0:23')
    expect(rows[1]!.get('.beat-preload-status').attributes('aria-busy')).toBe('true')
    expect(list.attributes('aria-label')).toBe('相邻歌曲节奏预分析')
    expect(list.attributes('aria-live')).toBe('off')
    expect(list.html()).not.toContain('private-preload-token')
    expect(list.findAll('button,input')).toHaveLength(0)
    expect(feedback.attributes('aria-busy')).toBe('false')
    expect(feedback.find('.beat-analysis-spinner').exists()).toBe(false)
    await wrapper.setProps({
      beatBuild: {
        ...status,
        adjacent: [previous, { ...next, phase: 'ready', progress: 1, availableSeconds: 180 }],
      },
    })
    expect(feedback.html()).toBe(before)
    expect(wrapper.findAll('.beat-preload-row')[1]!.element).toBe(rows[1]!.element)
    expect(rows[1]!.get('.beat-preload-label').text()).toBe('已就绪')
    expect(rows[1]!.get('.beat-preload-status').attributes('aria-busy')).toBe('false')
    expect(wrapper.emitted('beatBuildRetry')).toBeUndefined()
  })

  it.each([
    ['idle', 0, '等待预分析', false],
    ['loading-model', 0.5, '正在准备', true],
    ['fetching', 0.5, '正在准备', true],
    ['decoding', 0.5, '正在准备', true],
    ['analysing', 0, '正在准备', true],
    ['analysing', 0.42, '正在准备 · 42%', true],
    ['buffered', 0.5, '等待预分析', false],
    ['ready', 1, '已就绪', false],
    ['error', 0.5, '暂不可用', false],
  ] as const)(
    'reports adjacent %s state without treating preparation as ready',
    async (phase, progress, label, busy) => {
      const { wrapper } = mountPanel()
      await wrapper.setProps({
        beatBuild: {
          phase: 'analysing',
          progress: 0.2,
          error: null,
          adjacent: [preloadStatus({ phase, progress })],
        },
      })
      const row = wrapper.get('.beat-preload-row')
      expect(row.get('.beat-preload-label').text()).toBe(label)
      expect(row.get('.beat-preload-status').attributes('aria-busy')).toBe(String(busy))
      expect(row.find('.beat-analysis-spinner').exists()).toBe(busy)
      expect(wrapper.get('.beat-analysis-feedback [role="status"]').text()).toBe(
        '正在构建节奏 · 20%',
      )
    },
  )

  it('shows an available waiting prefix but never presents failed preloads as usable', async () => {
    const { wrapper } = mountPanel()
    const target = preloadStatus({
      phase: 'idle',
      availableSeconds: 24.9,
      durationSeconds: 180,
    })
    const status: BeatBuildStatus = {
      phase: 'ready',
      progress: 1,
      error: null,
      adjacent: [target],
    }
    await wrapper.setProps({ beatBuild: status })
    const row = wrapper.get('.beat-preload-row')
    expect(row.get('.beat-preload-label').text()).toBe('已备好 0:24')
    expect(row.get('.beat-preload-status').attributes('aria-busy')).toBe('false')
    await wrapper.setProps({
      beatBuild: {
        ...status,
        adjacent: [{ ...target, phase: 'error', error: '后续音频暂时无法读取' }],
      },
    })
    expect(row.get('.beat-preload-label').text()).toBe('暂不可用')
    expect(row.get('.beat-preload-status').attributes('title')).toContain('后续音频暂时无法读取')
    expect(row.attributes('aria-label')).toContain('暂不可用')
    expect(row.text()).not.toContain('已备好')
    expect(row.find('.beat-analysis-spinner').exists()).toBe(false)
    expect(wrapper.get('.beat-analysis-feedback [role="status"]').text()).toContain('预分析已完成')
    expect(wrapper.find('.beat-analysis-action').exists()).toBe(false)
  })

  it('labels only contiguous neighbor intros as buffered and leaves completed status distinct', async () => {
    const { wrapper } = mountPanel()
    const neighbor = preloadStatus({
      phase: 'buffered',
      progress: 0.4,
      availableSeconds: 48,
      durationSeconds: 120,
      completedRanges: [
        { startSeconds: 0, endSeconds: 24 },
        { startSeconds: 60, endSeconds: 84 },
      ],
    })
    const status: BeatBuildStatus = {
      phase: 'buffered',
      progress: 0.2,
      error: null,
      adjacent: [neighbor],
    }
    await wrapper.setProps({ beatBuild: status })
    const row = wrapper.get('.beat-preload-row')
    expect(row.get('.beat-preload-label').text()).toBe('开头已备好 0:24')
    expect(row.get('.beat-preload-status').attributes('aria-busy')).toBe('false')
    expect(row.find('.beat-analysis-spinner').exists()).toBe(false)
    expect(row.text()).not.toContain('已就绪')
    await wrapper.setProps({
      beatBuild: {
        ...status,
        adjacent: [{ ...neighbor, completedRanges: [{ startSeconds: 60, endSeconds: 84 }] }],
      },
    })
    expect(row.get('.beat-preload-label').text()).toBe('已保留部分结果')
    expect(row.text()).not.toContain('开头已备好')
    await wrapper.setProps({
      beatBuild: { ...status, adjacent: [{ ...neighbor, phase: 'ready' }] },
    })
    expect(wrapper.get('.beat-preload-row').element).toBe(row.element)
    expect(row.get('.beat-preload-label').text()).toBe('已就绪')
  })

  it('formats only measured adjacent availability and handles invalid numeric feedback', async () => {
    const { wrapper } = mountPanel()
    const target = preloadStatus({ phase: 'analysing', durationSeconds: 10 })
    const status: BeatBuildStatus = { phase: 'ready', progress: 1, error: null }
    await wrapper.setProps({ beatBuild: { ...status, adjacent: [{ ...target, progress: 0.5 }] } })
    const label = wrapper.get('.beat-preload-label')
    expect(label.text()).toBe('正在准备 · 50%')
    for (const invalid of [Number.NaN, Infinity, -1]) {
      await wrapper.setProps({
        beatBuild: {
          ...status,
          adjacent: [{ ...target, progress: invalid, availableSeconds: invalid }],
        },
      })
      expect(label.text()).toBe('正在准备')
    }
    await wrapper.setProps({
      beatBuild: { ...status, adjacent: [{ ...target, availableSeconds: 0.5 }] },
    })
    expect(label.text()).toBe('已备好不足1秒')
    await wrapper.setProps({
      beatBuild: { ...status, adjacent: [{ ...target, availableSeconds: 99 }] },
    })
    expect(label.text()).toBe('已备好 0:10')
    await wrapper.setProps({ beatBuild: { ...status, adjacent: [{ ...target, progress: 1.5 }] } })
    expect(label.text()).toBe('正在准备 · 100%')
    expect(label.text()).not.toBe('已就绪')
  })

  it('replaces adjacent titles and statuses together when the queue changes', async () => {
    const { wrapper } = mountPanel()
    const status: BeatBuildStatus = { phase: 'ready', progress: 1, error: null }
    await wrapper.setProps({
      beatBuild: {
        ...status,
        adjacent: [preloadStatus({ title: '旧歌曲', phase: 'ready', availableSeconds: 180 })],
      },
    })
    const row = wrapper.get('.beat-preload-row')
    await wrapper.setProps({
      beatBuild: {
        ...status,
        adjacent: [preloadStatus({ source: '/replacement.mp3', title: '  ' })],
      },
    })
    expect(wrapper.get('.beat-preload-row').element).toBe(row.element)
    expect(row.get('.beat-preload-title').text()).toBe('未命名歌曲')
    expect(row.get('.beat-preload-label').text()).toBe('等待预分析')
    expect(row.text()).not.toContain('旧歌曲')
    expect(row.text()).not.toContain('已就绪')
  })

  it.each(['beat-this-small', 'beat-this-standard'] as const)(
    'restores basic analysis from %s with background defaults without triggering a rebuild',
    async (mode) => {
      const { wrapper, store } = mountPanel()
      store.settings.beatAnalysisMode = mode
      const reset = sectionByTitle(wrapper, '背景')!.get('.section-reset')
      await reset.trigger('click')
      await reset.trigger('click')

      expect(store.settings.beatAnalysisMode).toBe('basic')
      expect(wrapper.emitted('beatBuildRetry')).toBeUndefined()
    },
  )

  it('keeps the equalizer controls collapsed while the equalizer is off', async () => {
    const { wrapper, store } = mountPanel()
    const equalizer = sectionByTitle(wrapper, '音效')!

    // 均衡器默认关闭,预设与频段一开始就应当是收起的
    expect(equalizer.find('.collapse-wrapper').classes()).not.toContain('expanded')
    expect(equalizer.find('.collapse-body').attributes('inert')).toBeDefined()

    store.settings.equalizer.enabled = true
    await nextTick()

    expect(equalizer.find('.collapse-wrapper').classes()).toContain('expanded')
    expect(equalizer.find('.collapse-body').attributes('inert')).toBeUndefined()
  })

  it('groups the lyric settings on their own instead of mixing them into 显示', () => {
    const { wrapper } = mountPanel()
    const lyrics = sectionByTitle(wrapper, '歌词')!
    const display = sectionByTitle(wrapper, '显示')!

    expect(lyrics.text()).toContain('歌词缩放')
    expect(lyrics.text()).toContain('歌词动画')
    expect(lyrics.text()).toContain('歌词小窗')
    expect(display.text()).not.toContain('歌词')
  })

  it('adjusts lyrics as a percentage of the responsive baseline in five-percent steps', async () => {
    const { wrapper, store } = mountPanel()
    const lyrics = sectionByTitle(wrapper, '歌词')!
    const scale = lyrics.findAll('[role="slider"]')[0]!

    expect(scale.attributes('aria-valuetext')).toBe('100%')
    expect(scale.attributes('aria-valuemin')).toBe('0.75')
    expect(scale.attributes('aria-valuemax')).toBe('1.5')
    await scale.trigger('keydown', { key: 'ArrowRight' })
    expect(store.settings.lyricScale).toBeCloseTo(1.05)
    expect(scale.attributes('aria-valuetext')).toBe('105%')
    await scale.trigger('keydown', { key: 'End' })
    expect(store.settings.lyricScale).toBe(1.5)
    expect(scale.attributes('aria-valuetext')).toBe('150%')
    expect(lyrics.text()).not.toContain('px')
    wrapper.unmount()
  })

  it('collapses the lyric spring slider together with the lyric animation toggle', async () => {
    const { wrapper, store } = mountPanel()
    const lyrics = sectionByTitle(wrapper, '歌词')!

    expect(lyrics.text()).toContain('歌词弹簧')
    expect(lyrics.find('.collapse-wrapper').classes()).toContain('expanded')

    store.settings.lyricAnimation = false
    await nextTick()

    // 关掉牵拉动画后弹簧系数没有作用对象
    expect(lyrics.find('.collapse-wrapper').classes()).not.toContain('expanded')
    expect(lyrics.find('.collapse-body').attributes('inert')).toBeDefined()
  })

  it('needs a second click on the reset button before it actually restores defaults', async () => {
    const { wrapper, store } = mountPanel()
    store.settings.lyricScale = 1.45
    store.settings.lyricAnimation = false
    store.settings.backgroundBlur = 130
    await nextTick()

    const reset = sectionByTitle(wrapper, '歌词')!.get('.section-reset')
    await reset.trigger('click')

    // 第一次点击只进入确认态,设置一个都不能变
    expect(reset.text()).toContain('再次点击')
    expect(store.settings.lyricScale).toBe(1.45)
    expect(store.settings.lyricAnimation).toBe(false)

    await reset.trigger('click')

    expect(reset.text()).toBe('恢复默认')
    expect(store.settings.lyricScale).toBe(1)
    expect(store.settings.lyricAnimation).toBe(true)
    // 其他分组不受影响
    expect(store.settings.backgroundBlur).toBe(130)
  })

  it('drops the pending confirmation when the second click never comes', async () => {
    vi.useFakeTimers()
    try {
      const { wrapper, store } = mountPanel()
      store.settings.lyricScale = 1.45
      const reset = sectionByTitle(wrapper, '歌词')!.get('.section-reset')

      await reset.trigger('click')
      expect(reset.text()).toContain('再次点击')

      vi.advanceTimersByTime(4000)
      await nextTick()

      expect(reset.text()).toBe('恢复默认')
      expect(store.settings.lyricScale).toBe(1.45)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SettingToggleRow', () => {
  it('toggles from anywhere on the row', async () => {
    const wrapper = mount(SettingToggleRow, {
      props: { modelValue: false, label: '平滑切歌', description: '切歌前淡出' },
    })

    await wrapper.get('.setting-row > span').trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
  })

  it('does not double-toggle when the switch itself is clicked', async () => {
    const wrapper = mount(SettingToggleRow, {
      props: { modelValue: false, label: '平滑切歌' },
    })

    // 开关自己会派发一次 change,冒泡到行上的 click 若不拦住就会再取反一次
    const input = wrapper.get('input[type="checkbox"]')
    ;(input.element as HTMLInputElement).checked = true
    await input.trigger('change')
    await input.trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
  })
})
