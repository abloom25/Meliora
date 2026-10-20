import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import SettingToggleRow from '../components/SettingToggleRow.vue'
import SettingsPanel from '../components/SettingsPanel.vue'
import type { Track } from '../core/types'
import { usePlayerStore } from '../stores/player'

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

describe('SettingsPanel', () => {
  beforeEach(() => setActivePinia(createPinia()))

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

    expect(lyrics.text()).toContain('歌词字号')
    expect(lyrics.text()).toContain('歌词动画')
    expect(lyrics.text()).toContain('歌词小窗')
    expect(display.text()).not.toContain('歌词')
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
    store.settings.lyricFontSize = 29
    store.settings.lyricAnimation = false
    store.settings.backgroundBlur = 130
    await nextTick()

    const reset = sectionByTitle(wrapper, '歌词')!.get('.section-reset')
    await reset.trigger('click')

    // 第一次点击只进入确认态,设置一个都不能变
    expect(reset.text()).toContain('再次点击')
    expect(store.settings.lyricFontSize).toBe(29)
    expect(store.settings.lyricAnimation).toBe(false)

    await reset.trigger('click')

    expect(reset.text()).toBe('恢复默认')
    expect(store.settings.lyricFontSize).toBe(20)
    expect(store.settings.lyricAnimation).toBe(true)
    // 其他分组不受影响
    expect(store.settings.backgroundBlur).toBe(130)
  })

  it('drops the pending confirmation when the second click never comes', async () => {
    vi.useFakeTimers()
    try {
      const { wrapper, store } = mountPanel()
      store.settings.lyricFontSize = 29
      const reset = sectionByTitle(wrapper, '歌词')!.get('.section-reset')

      await reset.trigger('click')
      expect(reset.text()).toContain('再次点击')

      vi.advanceTimersByTime(4000)
      await nextTick()

      expect(reset.text()).toBe('恢复默认')
      expect(store.settings.lyricFontSize).toBe(29)
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
