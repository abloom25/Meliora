import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import SettingToggleRow from '../components/SettingToggleRow.vue'
import SettingsPanel from '../components/SettingsPanel.vue'
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
