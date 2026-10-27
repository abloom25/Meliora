import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, effectScope, nextTick, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SongLyricsSettings from '../components/SongLyricsSettings.vue'
import { usePlayerStore } from '../stores/player'
import { createMemoryStore } from '../core/platform/storage'
import { setSettingsStore } from '../platform/settings-store'
import {
  invalidateTrackLyrics,
  loadTrackLyricsChoices,
  type TrackLyricsChoice,
} from '../services/lyrics'
import type { Track } from '../core/types'
import { useSongLyricsPreferences } from '../composables/useSongLyricsPreferences'

vi.mock('../services/lyrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/lyrics')>()),
  loadTrackLyricsChoices: vi.fn(),
  invalidateTrackLyrics: vi.fn(async () => undefined),
}))

const song: Track = {
  kind: 'local',
  id: 'one',
  title: 'One',
  artist: 'Artist',
  audioUrl: '/one.mp3',
}
const choices: TrackLyricsChoice[] = [
  { source: 'amll', lines: [{ time: 1, text: 'AMLL preview' }] },
  { source: 'local', lines: [{ time: 2, text: 'Local preview' }] },
]
const mounted: VueWrapper[] = []
const scopes: EffectScope[] = []
function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = usePlayerStore()
  store.setTracks([song, { ...song, id: 'two', title: 'Two' }])
  store.currentTrackId = song.id
  const wrapper = mount(SongLyricsSettings, { global: { plugins: [pinia] } })
  mounted.push(wrapper)
  return { wrapper, store }
}

function preferencesFor(store: ReturnType<typeof usePlayerStore>) {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() => useSongLyricsPreferences(computed(() => store.currentTrack)))!
}

describe('song lyric settings', () => {
  beforeEach(() => {
    setSettingsStore(createMemoryStore())
    vi.mocked(loadTrackLyricsChoices).mockReset().mockResolvedValue(choices)
    vi.mocked(invalidateTrackLyrics).mockClear()
  })
  afterEach(() => {
    scopes.splice(0).forEach((scope) => scope.stop())
    mounted.splice(0).forEach((wrapper) => wrapper.unmount())
    setSettingsStore(null)
  })

  it('loads sources only when expanded and lets preview change independently from selection', async () => {
    const { wrapper } = setup()
    expect(loadTrackLyricsChoices).not.toHaveBeenCalled()
    expect(wrapper.get('.collapse-body').attributes('inert')).toBeDefined()
    const toggle = wrapper.get('[aria-label="选择本曲歌词来源"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await toggle.trigger('click')
    await flushPromises()
    expect(loadTrackLyricsChoices).toHaveBeenCalledTimes(1)
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('.source-preview').text()).toBe('AMLL preview')
    await wrapper.findAll('.preview-button')[1]!.trigger('click')
    expect(wrapper.get('.source-preview').text()).toBe('Local preview')
    expect(wrapper.get('.source-choice[aria-pressed="true"]').text()).toContain('自动选择')
    await wrapper.findAll('.source-option .source-choice')[1]!.trigger('click')
    expect(wrapper.get('.source-choice[aria-pressed="true"]').text()).toContain('本地歌词')
    await wrapper.get('[aria-label="刷新本曲歌词"]').trigger('click')
    await flushPromises()
    expect(invalidateTrackLyrics).toHaveBeenCalledTimes(1)
    expect(loadTrackLyricsChoices).toHaveBeenCalledTimes(2)
  })

  it('keeps calibration disabled until an actual lyric source has resolved', async () => {
    const { wrapper, store } = setup()
    const preferences = preferencesFor(store)
    const earlier = wrapper.get<HTMLButtonElement>('[aria-label="歌词提前 0.1 秒"]')
    const later = wrapper.get<HTMLButtonElement>('[aria-label="歌词延后 0.1 秒"]')
    const reset = wrapper.get<HTMLButtonElement>('.offset-value')
    expect(earlier.element.disabled).toBe(true)
    expect(later.element.disabled).toBe(true)
    expect(reset.element.disabled).toBe(true)
    expect(reset.text().replace(/\s+/g, '')).toBe('0.0秒')
    preferences.setSource('amll')
    await nextTick()
    expect(later.element.disabled).toBe(true)
    preferences.reportSource('local')
    await nextTick()
    expect(earlier.element.disabled).toBe(false)
    expect(later.element.disabled).toBe(false)
    expect(reset.element.disabled).toBe(true)
  })

  it('adjusts the resolved source by 0.1 seconds and resets through the displayed value', async () => {
    const { wrapper, store } = setup()
    const preferences = preferencesFor(store)
    preferences.setSource('amll')
    preferences.reportSource('local')
    await nextTick()
    const earlier = wrapper.get('[aria-label="歌词提前 0.1 秒"]')
    const later = wrapper.get('[aria-label="歌词延后 0.1 秒"]')
    const reset = wrapper.get<HTMLButtonElement>('[aria-label="重置本曲歌词时间"]')
    await later.trigger('click')
    expect(preferences.getOffset('local')).toBe(100)
    expect(preferences.getOffset('amll')).toBe(0)
    expect(reset.text().replace(/\s+/g, '')).toBe('+0.1秒')
    expect(reset.get('output').attributes('aria-label')).toBe('延后 0.1 秒')
    expect(reset.element.disabled).toBe(false)
    await earlier.trigger('click')
    await earlier.trigger('click')
    expect(preferences.offsetMs.value).toBe(-100)
    expect(reset.text().replace(/\s+/g, '')).toBe('−0.1秒')
    expect(reset.get('output').attributes('aria-label')).toBe('提前 0.1 秒')
    await reset.trigger('click')
    expect(preferences.offsetMs.value).toBe(0)
    expect(reset.text().replace(/\s+/g, '')).toBe('0.0秒')
    expect(reset.element.disabled).toBe(true)
  })

  it('applies heard timing to the resolved source and never to a different song or preferred source', async () => {
    const { wrapper, store } = setup()
    const preferences = preferencesFor(store)
    preferences.setSource('amll')
    preferences.reportSource('local')
    store.isPlaying = true
    let time = 5
    await wrapper.setProps({
      getCalibrationLyrics: () => ({
        trackId: song.id,
        source: 'local',
        lines: [{ time: 10, text: 'Actual local lyric' }],
      }),
      getPlaybackState: () => ({
        timeSeconds: time,
        playing: true,
        playbackRate: 1,
        seeking: false,
      }),
    })
    await wrapper.get('.calibration-toggle').trigger('click')
    time = 10.6
    await wrapper.get('.capture-timing').trigger('click')
    await wrapper.get('.apply-timing').trigger('click')
    expect(preferences.getOffset('local')).toBe(600)
    expect(preferences.getOffset('amll')).toBe(0)
    expect(loadTrackLyricsChoices).not.toHaveBeenCalled()
    store.currentTrackId = 'two'
    await nextTick()
    expect(wrapper.get<HTMLButtonElement>('.calibration-toggle').element.disabled).toBe(true)
  })

  it.each([
    [-29900, '歌词提前 0.1 秒', -30000, '−30.0秒', '提前 30.0 秒'],
    [29900, '歌词延后 0.1 秒', 30000, '+30.0秒', '延后 30.0 秒'],
  ] as const)(
    'shows and respects the calibration boundary from %s ms',
    async (initial, label, expected, displayed, description) => {
      const { wrapper, store } = setup()
      const preferences = preferencesFor(store)
      preferences.reportSource('local')
      preferences.setOffset(initial)
      await nextTick()
      const adjust = wrapper.get(`[aria-label="${label}"]`)
      await adjust.trigger('click')
      expect(preferences.offsetMs.value).toBe(expected)
      const value = wrapper.get('.offset-value')
      expect(value.text().replace(/\s+/g, '')).toBe(displayed)
      expect(value.get('output').attributes('aria-label')).toBe(description)
      await adjust.trigger('click')
      expect(preferences.offsetMs.value).toBe(expected)
    },
  )

  it('shows skeletons while loading and ignores source results from a previous song', async () => {
    let finish!: (value: TrackLyricsChoice[]) => void
    vi.mocked(loadTrackLyricsChoices).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const { wrapper, store } = setup()
    await wrapper.get('.source-toggle').trigger('click')
    expect(wrapper.find('.choices-state .song-info-placeholder').exists()).toBe(true)
    const firstSignal = vi.mocked(loadTrackLyricsChoices).mock.calls[0]?.[1]
    vi.mocked(loadTrackLyricsChoices).mockResolvedValueOnce([
      { source: 'local', lines: [{ time: 0, text: 'New song' }] },
    ])
    store.currentTrackId = 'two'
    await flushPromises()
    expect(firstSignal?.aborted).toBe(true)
    finish(choices)
    await flushPromises()
    expect(wrapper.get('.source-preview').text()).toBe('New song')
    expect(wrapper.text()).not.toContain('AMLL preview')
  })
})
