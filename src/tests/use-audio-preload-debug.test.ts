import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { useAudioPreloadDebug } from '../platform/web/useAudioPreloadDebug'
import type { AudioChannel } from '../core/audio/backend'
import type { Track } from '../core/types'

enableAutoUnmount(afterEach)

function fixture() {
  const track: Track = {
    id: 'next',
    title: 'Next song',
    artist: 'Artist',
    kind: 'remote',
    audioUrl: 'https://media.example/next.mp3?token=private',
  }
  const channel: AudioChannel = {
    setPreload: vi.fn(),
    id: 'slot-2',
    load: vi.fn(),
    source: vi.fn(() => track.audioUrl),
    release: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    currentTime: vi.fn(() => 12),
    seek: vi.fn(),
    duration: vi.fn(() => 180),
    setGain: vi.fn(),
    gain: vi.fn(() => 0),
    canStart: vi.fn(() => true),
    failed: vi.fn(() => false),
    ended: vi.fn(() => false),
    classifyFailure: vi.fn(() => 'unknown' as const),
    on: vi.fn(() => vi.fn()),
  }
  const slot = {
    direction: 'next' as const,
    channel,
    track,
    audio: new Audio(),
    protected: false,
  }
  Object.defineProperties(slot.audio, {
    buffered: {
      configurable: true,
      value: {
        length: 2,
        start: (index: number) => [0, 50][index],
        end: (index: number) => [20, 80][index],
      },
    },
    readyState: { configurable: true, value: 3 },
    networkState: { configurable: true, value: 2 },
  })
  const enabled = ref(false)
  const getSlots = vi.fn(() => [slot])
  let debug!: ReturnType<typeof useAudioPreloadDebug>
  const wrapper = mount(
    defineComponent({
      setup() {
        debug = useAudioPreloadDebug({ enabled, getSlots, getElements: () => [slot.audio] })
        return () => h('div')
      },
    }),
  )
  return { slot, channel, enabled, getSlots, debug, wrapper }
}

describe('useAudioPreloadDebug', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('observes actual media ranges only while enabled, without controlling playback or exposing URLs', () => {
    const { enabled, debug, getSlots, slot, channel } = fixture()
    debug.refresh()
    slot.audio.dispatchEvent(new Event('progress'))
    expect(getSlots).not.toHaveBeenCalled()
    expect(debug.state.value).toEqual([])

    enabled.value = true
    expect(debug.state.value[0]).toMatchObject({
      direction: 'next',
      channelId: 'slot-2',
      trackId: 'next',
      title: 'Next song',
      phase: 'ready',
      currentTimeSeconds: 12,
      durationSeconds: 180,
      readyState: 3,
      networkState: 2,
      bufferedRanges: [
        { startSeconds: 0, endSeconds: 20 },
        { startSeconds: 50, endSeconds: 80 },
      ],
    })
    expect(JSON.stringify(debug.state.value)).not.toMatch(/private|media\.example/)
    for (const method of [channel.load, channel.play, channel.pause, channel.seek, channel.release])
      expect(method).not.toHaveBeenCalled()
  })

  it('coalesces media events and cancels pending reads when closed or unmounted', () => {
    const { enabled, getSlots, slot, debug, wrapper } = fixture()
    enabled.value = true
    for (let i = 0; i < 20; i++) slot.audio.dispatchEvent(new Event('progress'))
    expect(getSlots).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    expect(getSlots).toHaveBeenCalledTimes(2)
    slot.audio.dispatchEvent(new Event('progress'))
    enabled.value = false
    vi.advanceTimersByTime(1000)
    expect(getSlots).toHaveBeenCalledTimes(2)
    expect(debug.state.value).toEqual([])
    enabled.value = true
    const beforeUnmount = getSlots.mock.calls.length
    slot.audio.dispatchEvent(new Event('progress'))
    wrapper.unmount()
    slot.audio.dispatchEvent(new Event('canplay'))
    vi.advanceTimersByTime(1000)
    expect(getSlots).toHaveBeenCalledTimes(beforeUnmount)
  })

  it('rebinds listeners after native media replacement and reports failures without throwing', () => {
    const { enabled, slot, debug, getSlots } = fixture()
    enabled.value = true
    const oldAudio = slot.audio
    slot.audio = new Audio()
    slot.protected = true
    Object.defineProperties(slot.audio, {
      error: { value: { code: 2 } },
      buffered: {
        get: () => {
          throw new Error('media source cleared')
        },
      },
    })
    debug.refresh()
    vi.advanceTimersByTime(100)
    expect(debug.state.value[0]).toMatchObject({
      phase: 'protected',
      failed: true,
      error: '音频网络错误',
      bufferedRanges: [],
    })
    const reads = getSlots.mock.calls.length
    vi.advanceTimersByTime(100)
    oldAudio.dispatchEvent(new Event('progress'))
    expect(getSlots).toHaveBeenCalledTimes(reads)
    slot.audio.dispatchEvent(new Event('progress'))
    expect(getSlots).toHaveBeenCalledTimes(reads + 1)
  })

  it('suspends hidden-page reads and refreshes when visible again', () => {
    const { enabled, slot, getSlots } = fixture()
    enabled.value = true
    slot.audio.dispatchEvent(new Event('progress'))
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(1000)
    slot.audio.dispatchEvent(new Event('progress'))
    expect(getSlots).toHaveBeenCalledTimes(1)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(getSlots).toHaveBeenCalledTimes(2)
  })
})
