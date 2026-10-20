import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref } from 'vue'
import type { UseAudioPlayerOptions } from '../composables/useAudioPlayer'
import { usePlayerStore } from '../stores/player'
import PlayerView from '../views/PlayerView.vue'

let audioOptions: UseAudioPlayerOptions | undefined
const comparisonCommands = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), export: vi.fn() }))

vi.mock('../composables/useAudioPlayer', () => ({
  useAudioPlayer: (options: UseAudioPlayerOptions) => {
    audioOptions = options
    return {
      preloadMessage: ref(''),
      spectrumAvailable: ref(false),
      toggle: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      next: vi.fn(),
      previous: vi.fn(),
      selectAndPlay: vi.fn(),
      retryBeatBuild: vi.fn(),
      beatBuildStatus: ref({ phase: 'idle', progress: 0, error: null }),
      beatDebug: ref(null),
      beatSchedulerDebug: ref(null),
      beatComparison: ref(null),
      canCompareBeats: ref(true),
      startBeatComparison: comparisonCommands.start,
      stopBeatComparison: comparisonCommands.stop,
      beatComparisonRecording: ref({ sampleCount: 45, truncated: false }),
      exportBeatComparison: comparisonCommands.export,
      beatComparisonExporting: ref(false),
      beatComparisonExportError: ref(null),
      audioPreloadDebug: ref([]),
    }
  },
}))

vi.mock('../composables/usePlayerLibrary', () => ({
  usePlayerLibrary: () => ({
    runtimeConfig: ref({ siteName: 'Meliora' }),
    query: ref(''),
    loading: ref(false),
    loadFailed: ref(false),
    sourceWarning: ref(''),
    filteredTracks: computed(() => usePlayerStore().tracks),
    loadTracks: vi.fn(async () => {}),
  }),
}))

function mountPlayer(realLyrics = false) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = usePlayerStore()
  store.setTracks([
    { id: 'one', title: '测试歌曲', artist: '歌手', audioUrl: '/one.mp3', kind: 'local' },
  ])
  const wrapper = mount(PlayerView, {
    attachTo: document.body,
    global: {
      plugins: [pinia],
      stubs: {
        ArtworkBackground: true,
        LyricsPanel: !realLyrics,
        PlayerControls: true,
        TrackList: true,
        BeatAnalysisSettings: true,
      },
    },
  })
  return {
    wrapper,
    store,
    cleanup() {
      wrapper.unmount()
      disposePinia(pinia)
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  audioOptions = undefined
  comparisonCommands.start.mockClear()
  comparisonCommands.stop.mockClear()
  comparisonCommands.export.mockClear()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('player debug integration', () => {
  it('hides debug settings and rejects a forced opt-in outside development', async () => {
    vi.stubEnv('DEV', false)
    localStorage.setItem('meliora:settings', JSON.stringify({ debugPanelEnabled: true }))
    const { wrapper, store, cleanup } = mountPlayer()
    try {
      expect(store.settings.debugPanelEnabled).toBe(false)
      store.settings.debugPanelEnabled = true
      await nextTick()
      await wrapper.get('.settings-button').trigger('click')
      expect(wrapper.find('input[aria-label="播放器调试面板"]').exists()).toBe(false)
      expect(wrapper.find('.debug-button').exists()).toBe(false)
      expect(wrapper.find('.debug-drawer').exists()).toBe(false)
      expect(audioOptions?.debugEnabled?.value).toBe(false)
      expect(audioOptions?.beatComparisonEnabled?.value).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('opens comparison explicitly and wires its commands without changing playback mode', async () => {
    const { wrapper, store, cleanup } = mountPlayer()
    try {
      store.settings.debugPanelEnabled = true
      await nextTick()
      await wrapper.get('.top-actions .debug-button').trigger('click')
      await vi.dynamicImportSettled()
      await flushPromises()
      expect(audioOptions?.beatComparisonEnabled?.value).toBe(false)
      await wrapper.get('[role="tab"][aria-controls$="comparison"]').trigger('click')
      expect(audioOptions?.beatComparisonEnabled?.value).toBe(true)
      const panel = wrapper.findComponent({ name: 'PlayerDebugPanel' })
      panel.vm.$emit('compare-start')
      panel.vm.$emit('compare-stop')
      panel.vm.$emit('compare-export')
      expect(comparisonCommands.start).toHaveBeenCalledTimes(1)
      expect(comparisonCommands.stop).toHaveBeenCalledTimes(1)
      expect(comparisonCommands.export).toHaveBeenCalledTimes(1)
      expect(panel.props('comparisonExportSampleCount')).toBe(45)
      expect(store.settings.beatAnalysisMode).toBe('basic')
      await wrapper.get('[role="tab"][aria-controls$="beat"]').trigger('click')
      expect(audioOptions?.beatComparisonEnabled?.value).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('connects real lyric, runtime, and popup diagnostics while preserving the debug panel', async () => {
    const popup = vi.spyOn(window, 'open').mockReturnValue(null)
    const { wrapper, store, cleanup } = mountPlayer(true)
    try {
      store.selectTrack(store.tracks[0]!, store.tracks)
      store.settings.debugPanelEnabled = true
      await nextTick()
      await wrapper.get('.top-actions .debug-button').trigger('click')
      await vi.dynamicImportSettled()
      await flushPromises()
      const panel = wrapper.findComponent({ name: 'PlayerDebugPanel' })
      await vi.waitFor(() => expect(panel.props('lyrics')?.trackId).toBe('one'))
      expect(panel.props('runtime')?.network.online).toBe(navigator.onLine)
      expect(panel.props('lyricsWindow')?.open).toBe(false)
      expect(panel.props('lyricsWindowSupported')).toBe(true)
      panel.vm.$emit('toggle-lyrics-window')
      await flushPromises()
      expect(popup).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(panel.props('lyricsWindow')?.lastFailure).toBeTruthy())
      expect(wrapper.find('.debug-drawer').exists()).toBe(true)
      expect(audioOptions?.debugEnabled?.value).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('enables diagnostics only while the explicitly enabled panel is open', async () => {
    const { wrapper, store, cleanup } = mountPlayer()
    try {
      expect(wrapper.find('.debug-button').exists()).toBe(false)
      expect(audioOptions?.debugEnabled?.value).toBe(false)
      await wrapper.get('.settings-button').trigger('click')
      await wrapper.get('input[aria-label="播放器调试面板"]').setValue(true)
      expect(store.settings.debugPanelEnabled).toBe(true)
      expect(wrapper.find('.top-actions .debug-button').exists()).toBe(true)
      expect(wrapper.find('.debug-drawer').exists()).toBe(false)
      expect(audioOptions?.debugEnabled?.value).toBe(false)

      const trigger = wrapper.get<HTMLButtonElement>('.top-actions .debug-button')
      trigger.element.focus()
      await trigger.trigger('click')
      expect(wrapper.find('.settings-drawer').exists()).toBe(false)
      expect(wrapper.get('.debug-drawer').attributes('tabindex')).toBe('-1')
      expect(audioOptions?.debugEnabled?.value).toBe(true)
      await vi.dynamicImportSettled()
      await flushPromises()
      expect(wrapper.find('.player-debug-panel').exists()).toBe(true)
      expect(wrapper.get('.debug-drawer').element.contains(document.activeElement)).toBe(true)

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
      await nextTick()
      await flushPromises()
      expect(wrapper.find('.debug-drawer').exists()).toBe(false)
      expect(audioOptions?.debugEnabled?.value).toBe(false)
      await vi.waitFor(() => expect(document.activeElement).toBe(trigger.element))

      await trigger.trigger('click')
      await flushPromises()
      expect(audioOptions?.debugEnabled?.value).toBe(true)
      await wrapper.get('.player-debug-panel button[aria-label="关闭调试面板"]').trigger('click')
      expect(audioOptions?.debugEnabled?.value).toBe(false)
      expect(wrapper.find('.debug-drawer').exists()).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('stops diagnostics on settings handoff, disabling the preference, and an empty library', async () => {
    const { wrapper, store, cleanup } = mountPlayer()
    try {
      store.settings.debugPanelEnabled = true
      await nextTick()
      await wrapper.get('.top-actions .debug-button').trigger('click')
      await wrapper.get('.settings-button').trigger('click')
      expect(wrapper.find('.debug-drawer').exists()).toBe(false)
      expect(audioOptions?.debugEnabled?.value).toBe(false)

      await wrapper.get('.top-actions .debug-button').trigger('click')
      expect(audioOptions?.debugEnabled?.value).toBe(true)
      store.settings.debugPanelEnabled = false
      await nextTick()
      expect(wrapper.find('.debug-drawer').exists()).toBe(false)
      expect(wrapper.find('.top-actions .debug-button').exists()).toBe(false)
      expect(audioOptions?.debugEnabled?.value).toBe(false)

      store.settings.debugPanelEnabled = true
      await nextTick()
      await wrapper.get('.top-actions .debug-button').trigger('click')
      store.setTracks([])
      await nextTick()
      expect(wrapper.find('.debug-drawer').exists()).toBe(false)
      expect(wrapper.find('.top-actions .debug-button').exists()).toBe(false)
      expect(wrapper.get('.settings-button').attributes('disabled')).toBeDefined()
      expect(audioOptions?.debugEnabled?.value).toBe(false)
    } finally {
      cleanup()
    }
  })
})
