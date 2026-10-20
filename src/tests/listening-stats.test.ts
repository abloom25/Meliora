import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import {
  createListeningCounter,
  isFrequentlyPlayed,
  listeningTrackKey,
  sanitizeListeningRecords,
  type ListeningSample,
} from '../core/playback/listening-stats'
import type { Track } from '../core/types'
import { createMemoryStore } from '../core/platform/storage'
import { setSettingsStore } from '../platform/settings-store'
import { useListeningStats } from '../platform/web/useListeningStats'
import { beatResultCache } from '../platform/web/beat-result-cache'
import {
  clearListeningHistory,
  listeningStatsSummary,
  recordListening,
} from '../platform/web/listening-history'

const track: Track = {
  id: 'song',
  kind: 'local',
  title: 'Same title',
  artist: 'Artist',
  audioUrl: '/song.mp3',
}
const sample = (seconds: number, extra: Partial<ListeningSample> = {}): ListeningSample => ({
  nowMs: seconds * 1000,
  timeSeconds: seconds,
  durationSeconds: 200,
  playbackRate: 1,
  playing: true,
  seeking: false,
  ...extra,
})

afterEach(async () => {
  vi.spyOn(beatResultCache.store, 'clear').mockResolvedValue()
  await clearListeningHistory()
  setSettingsStore(null)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('listening rules', () => {
  it('counts actual playback once per visit and excludes jumps, paused clocks and stalls', () => {
    const counter = createListeningCounter()
    counter.sample(sample(0))
    for (let second = 1; second < 30; second++)
      expect(counter.sample(sample(second)).qualified).toBe(false)
    expect(counter.sample(sample(30))).toEqual({ seconds: 1, qualified: true })
    expect(counter.sample(sample(31))).toEqual({ seconds: 1, qualified: false })
    expect(counter.sample(sample(32, { timeSeconds: 100, seeking: true })).seconds).toBe(0)
    expect(counter.sample(sample(33, { timeSeconds: 100, seeking: false })).seconds).toBe(0)
    expect(counter.sample(sample(34, { timeSeconds: 101, playing: false })).seconds).toBe(1)
    expect(counter.sample(sample(35, { timeSeconds: 102, playing: false })).seconds).toBe(0)
    expect(counter.sample(sample(90, { timeSeconds: 130 })).seconds).toBe(0)
  })

  it('uses half the duration for short songs and does not turn playback speed into extra listening time', () => {
    const counter = createListeningCounter()
    counter.sample(sample(0, { durationSeconds: 8, playbackRate: 2 }))
    for (let index = 1; index <= 4; index++) {
      expect(
        counter.sample(
          sample(index, { timeSeconds: index * 2, durationSeconds: 8, playbackRate: 2 }),
        ),
      ).toEqual({ seconds: 1, qualified: index === 4 })
    }
    counter.reset()
    expect(counter.sample(sample(100))).toEqual({ seconds: 0, qualified: false })
  })

  it('separates same-name source IDs, requires two real plays and bounds persisted history', () => {
    expect(listeningTrackKey(track)).not.toBe(listeningTrackKey({ ...track, kind: 'remote' }))
    expect(listeningTrackKey(track)).not.toBe(listeningTrackKey({ ...track, id: 'other' }))
    const base = {
      key: 'a',
      title: '',
      artist: '',
      qualifiedPlays: 1,
      listenedSeconds: 30,
      lastPlayedAt: 1,
    }
    expect(isFrequentlyPlayed(base)).toBe(false)
    expect(isFrequentlyPlayed({ ...base, qualifiedPlays: 2 })).toBe(true)
    expect(isFrequentlyPlayed({ ...base, qualifiedPlays: 2, listenedSeconds: 0 })).toBe(false)
    const sanitized = sanitizeListeningRecords([
      { ...base, qualifiedPlays: NaN },
      ...Array.from({ length: 502 }, (_, i) => ({ ...base, key: String(i), lastPlayedAt: i })),
    ])
    expect(sanitized).toHaveLength(500)
    expect(sanitized[0]!.key).toBe('501')
  })
})

describe('active-player listening history', () => {
  it('counts only active audio, persists two visits and resets a running visit on clear', async () => {
    setSettingsStore(createMemoryStore())
    vi.spyOn(beatResultCache.store, 'clear').mockResolvedValue()
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock * 1000)
    const active = document.createElement('audio')
    const neighbour = document.createElement('audio')
    for (const audio of [active, neighbour])
      Object.defineProperties(audio, {
        duration: { value: 60, configurable: true },
        paused: { value: false, configurable: true },
        readyState: { value: 4, configurable: true },
        ended: { value: false, configurable: true },
      })
    let stats!: ReturnType<typeof useListeningStats>
    const wrapper = mount(
      defineComponent({
        setup() {
          stats = useListeningStats({
            track: ref(track),
            players: [active, neighbour],
            getActiveAudio: () => active,
            isPlaying: ref(true),
          })
          return () => h('div')
        },
      }),
    )
    const advance = (amount: number): void => {
      for (let i = 0; i < amount; i++) {
        clock++
        active.currentTime++
        active.dispatchEvent(new Event('timeupdate'))
      }
    }
    neighbour.currentTime = 100
    neighbour.dispatchEvent(new Event('timeupdate'))
    active.dispatchEvent(new Event('stalled')) // Buffered playback continues, with no new playing event.
    advance(30)
    expect(stats.stats.value.totalQualifiedPlays).toBe(1)
    expect(stats.stats.value.frequentTracks).toBe(0)
    active.dispatchEvent(new Event('ended'))
    active.currentTime = 0
    active.dispatchEvent(new Event('playing'))
    advance(30)
    expect(stats.stats.value.totalQualifiedPlays).toBe(2)
    expect(stats.stats.value.totalListenedSeconds).toBe(60)
    expect(stats.stats.value.frequentTracks).toBe(1)
    await stats.clear()
    advance(1) // First sample establishes the post-clear baseline.
    advance(29)
    expect(stats.stats.value.totalQualifiedPlays).toBe(0)
    advance(1)
    expect(stats.stats.value.totalQualifiedPlays).toBe(1)
    stats.restartVisit()
    advance(30)
    expect(stats.stats.value.totalQualifiedPlays).toBe(2)
    wrapper.unmount()
  })

  it('preserves genuine play totals in storage and reports failed clearing instead of success', async () => {
    const storage = createMemoryStore()
    setSettingsStore(storage)
    recordListening(track, 30, true)
    recordListening(track, 30, true)
    expect(JSON.parse(storage.getItem('meliora:listening-history:v1')!).records[0]).toMatchObject({
      qualifiedPlays: 2,
      listenedSeconds: 60,
    })
    vi.spyOn(beatResultCache.store, 'clear').mockRejectedValue(new Error('storage denied'))
    await expect(clearListeningHistory()).rejects.toThrow('storage denied')
    expect(listeningStatsSummary.value.trackedTracks).toHaveLength(1)
    expect(listeningStatsSummary.value.totalQualifiedPlays).toBe(2)
    expect(
      JSON.parse(storage.getItem('meliora:listening-history:v1')!).records[0].qualifiedPlays,
    ).toBe(2)
  })
})
