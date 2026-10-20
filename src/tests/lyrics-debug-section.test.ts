import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import LyricsDebugSection from '../components/LyricsDebugSection.vue'
import type {
  LyricsDebugSnapshot,
  LyricsWindowDebugSnapshot,
} from '../core/diagnostics/lyrics-debug'

function lyrics(overrides: Partial<LyricsDebugSnapshot> = {}): LyricsDebugSnapshot {
  return {
    sampledAtMs: 20000,
    trackId: 'track-1',
    status: 'ready',
    source: 'amll',
    lineCount: 80,
    wordLineCount: 60,
    wordCount: 420,
    translationLineCount: 40,
    romanLineCount: 20,
    harmonyLineCount: 3,
    activeIndices: [4],
    activeLines: [
      { index: 4, text: '正在唱的歌词', background: false, timeSeconds: 12.2, wordCount: 7 },
    ],
    mediaSeconds: 13.4,
    clockSeconds: 13.405,
    clockDriftMs: 5,
    playing: true,
    panelActive: true,
    animationEnabled: true,
    translationEnabled: true,
    documentHidden: false,
    reducedMotion: false,
    renderLoopRunning: true,
    userBrowsing: false,
    sceneHeld: false,
    engine: {
      mountedLineCount: 80,
      stagedLineCount: 12,
      visibleLineCount: 5,
      animatingLineCount: 2,
      viewportHeight: 500,
      offset: 100,
      browseOffset: 0,
      scrollMode: 'follow',
      flingVelocity: 0,
      frameScheduled: true,
      anchorIndex: 4,
    },
    ...overrides,
  }
}
function windowState(
  overrides: Partial<LyricsWindowDebugSnapshot> = {},
): LyricsWindowDebugSnapshot {
  return {
    sampledAtMs: 20000,
    open: false,
    opening: false,
    kind: null,
    width: null,
    height: null,
    visible: null,
    nodesReady: false,
    trackId: null,
    status: 'idle',
    source: null,
    mountedLineCount: 0,
    activeSlots: [],
    renderedActiveIndex: -1,
    karaokeRunning: false,
    animatedWordCount: 0,
    scrollAnimationCount: 0,
    mediaSeconds: 0,
    clockSeconds: 0,
    animationEnabled: true,
    reducedMotion: null,
    lastFailure: null,
    lifecycle: [],
    ...overrides,
  }
}

describe('LyricsDebugSection', () => {
  it('keeps unavailable snapshots distinct from closed windows and zero lyric counts', () => {
    const wrapper = mount(LyricsDebugSection, { props: { lyrics: null, lyricsWindow: null } })
    expect(wrapper.text()).toContain('尚无歌词诊断数据')
    expect(wrapper.text()).toContain('尚无小窗快照')
    expect(wrapper.text()).toContain('当前环境不支持歌词小窗')
    expect(wrapper.text()).not.toContain('已关闭')
    expect(wrapper.find('.lyrics-debug-details').exists()).toBe(false)
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
  })

  it('presents real clocks, active lines and independent renderer counts', async () => {
    const wrapper = mount(LyricsDebugSection, {
      props: {
        lyrics: lyrics({ renderSchedule: 'timer' }),
        lyricsWindow: windowState({ renderSchedule: 'idle' }),
      },
    })
    expect(wrapper.text()).toContain('AMLL')
    expect(wrapper.text()).toContain('等待歌词边界')
    expect(wrapper.text()).toContain('已停止')
    expect(wrapper.text()).toContain('80 / 60')
    expect(wrapper.text()).toContain('80 / 12 / 5')
    expect(wrapper.text()).toContain('13.400 / 13.405 s')
    expect(wrapper.text()).toContain('5.0 ms')
    expect(wrapper.get('.lyrics-debug-preview').text()).toContain('第 5 行')
    await wrapper.setProps({
      lyrics: lyrics({
        activeIndices: [],
        activeLines: [],
        engine: null,
        playing: false,
        renderLoopRunning: false,
      }),
    })
    expect(wrapper.find('.lyrics-debug-preview').exists()).toBe(false)
    expect(wrapper.text()).toContain('当前没有活跃歌词行')
    expect(wrapper.text()).toContain('歌词渲染引擎尚未挂载')
    expect(wrapper.text()).toContain('已暂停')
  })

  it('allows synchronous opening only when supported with a track, and closing after the track is removed', async () => {
    const wrapper = mount(LyricsDebugSection, {
      props: {
        lyrics: null,
        lyricsWindow: windowState(),
        lyricsWindowSupported: true,
        hasCurrentTrack: false,
      },
    })
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('请先选择歌曲')
    await wrapper.setProps({ hasCurrentTrack: true })
    wrapper.get('button').element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(wrapper.emitted('toggle-lyrics-window')).toEqual([[]])
    await wrapper.setProps({ lyricsWindow: windowState({ opening: true }) })
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    expect(wrapper.get('button').text()).toContain('正在打开小窗')
    await wrapper.setProps({
      hasCurrentTrack: false,
      lyricsWindowSupported: false,
      lyricsWindow: windowState({ open: true, kind: 'document-pip' }),
    })
    expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('button').text()).toContain('关闭歌词小窗')
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('toggle-lyrics-window')).toHaveLength(2)
  })

  it('bounds previews and lifecycle history and does not expose private failure URLs', () => {
    const wrapper = mount(LyricsDebugSection, {
      props: {
        lyrics: lyrics({
          activeLines: Array.from({ length: 10 }, (_, index) => ({
            index,
            text: '歌词'.repeat(100),
            background: false,
            timeSeconds: index,
            wordCount: 2,
          })),
        }),
        lyricsWindow: windowState({
          lastFailure: '失败 https://example.test/a?token=private-token token=other-secret',
          activeSlots: [0, 2],
          renderedActiveIndex: 4,
          lifecycle: Array.from({ length: 20 }, (_, index) => ({
            atMs: index * 1000,
            event: 'opened' as const,
          })),
        }),
      },
    })
    expect(wrapper.findAll('.lyrics-debug-preview li')).toHaveLength(3)
    expect(wrapper.get('.lyrics-debug-preview p').text()).toHaveLength(120)
    expect(wrapper.findAll('.lyrics-debug-lifecycle li')).toHaveLength(12)
    expect(wrapper.get('.lyrics-debug-lifecycle li').text()).toContain('1.0 秒前')
    expect(wrapper.text()).toContain('逐字绑定槽（从 0 计）')
    expect(wrapper.text()).toContain('0、2')
    expect(wrapper.html()).not.toContain('private-token')
    expect(wrapper.html()).not.toContain('other-secret')
  })
})
