import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import LyricsTimingCalibration from '../components/LyricsTimingCalibration.vue'
import {
  calibrationLines,
  calibratedOffset,
  recordCalibrationSample,
  type LyricCalibrationContext,
} from '../core/lyrics/calibration'
import type { LyricPlaybackState } from '../core/lyrics/render-schedule'

const context: LyricCalibrationContext = {
  trackId: 'song',
  source: 'amll',
  lines: [
    { time: 10, text: 'First' },
    { time: 20, text: 'Second' },
    { time: 30, text: 'Third' },
  ],
}
const mounted: VueWrapper[] = []
function setup() {
  const state: LyricPlaybackState = {
    timeSeconds: 5,
    playing: true,
    playbackRate: 1,
    seeking: false,
  }
  const onApply = vi.fn()
  const wrapper = mount(LyricsTimingCalibration, {
    props: { context, getPlaybackState: () => state, offsetMs: 0, playing: true, onApply },
  })
  mounted.push(wrapper)
  return { wrapper, state, onApply }
}
afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('lyric timing calibration', () => {
  it('ignores untimed and backing vocals, preserves original indices and rejects distant taps', () => {
    expect(
      calibrationLines([
        { time: null, text: 'Title' },
        { time: 1, text: 'Backing', background: true },
        { time: 2, text: 'Lead' },
      ]).map(({ index }) => index),
    ).toEqual([2])
    expect(recordCalibrationSample([], 0, 10, 41)).toBeNull()
    expect(recordCalibrationSample([], 0, 10, Number.NaN)).toBeNull()
    expect(calibratedOffset([])).toBeNull()
  })

  it('uses a bounded set of distinct samples and a median so an accidental late tap does not dominate', () => {
    let samples = [
      { index: 0, offsetMs: 9000 },
      { index: 1, offsetMs: 430 },
    ]
    samples = recordCalibrationSample(samples, 2, 20, 20.51)!
    expect(calibratedOffset(samples)).toBe(500)
    samples = recordCalibrationSample(samples, 0, 10, 10.4)!
    expect(samples).toHaveLength(3)
    expect(calibratedOffset(samples)).toBe(400)
    for (let index = 3; index < 12; index++)
      samples = recordCalibrationSample(samples, index, 10, 9.6)!
    expect(samples).toHaveLength(5)
    expect(calibratedOffset(samples)).toBe(-400)
  })

  it('records the actual playback clock against raw source times and applies only on request', async () => {
    const { wrapper, state, onApply } = setup()
    await wrapper.setProps({ offsetMs: 200 })
    await wrapper.get('.calibration-toggle').trigger('click')
    expect(wrapper.get('.calibration-line span').text()).toBe('First')
    state.timeSeconds = 10.43
    await wrapper.get('.capture-timing').trigger('click')
    expect(onApply).not.toHaveBeenCalled()
    expect(wrapper.get('.calibration-line span').text()).toBe('Second')
    expect(wrapper.get('.calibration-status').text()).toContain('延后 0.4 秒')
    state.timeSeconds = 20.51
    await wrapper.get('.capture-timing').trigger('click')
    state.timeSeconds = 39
    await wrapper.get('.capture-timing').trigger('click')
    await wrapper.get('.apply-timing').trigger('click')
    expect(onApply).toHaveBeenCalledExactlyOnceWith(500)
    expect(state.timeSeconds).toBe(39)
    expect(wrapper.get('.calibration-toggle').attributes('aria-expanded')).toBe('false')
  })

  it('rejects paused, buffering and seeking clocks even if the UI still requests playback', async () => {
    const { wrapper, state, onApply } = setup()
    await wrapper.get('.calibration-toggle').trigger('click')
    state.playing = false
    await wrapper.get('.capture-timing').trigger('click')
    expect(wrapper.get('.calibration-status').text()).toContain('正常播放')
    state.playing = true
    state.seeking = true
    await wrapper.get('.capture-timing').trigger('click')
    expect(wrapper.get<HTMLButtonElement>('.apply-timing').element.disabled).toBe(true)
    expect(onApply).not.toHaveBeenCalled()
  })

  it.each(['song', 'source', 'lines', 'offset'] as const)(
    'discards a draft when %s changes',
    async (change) => {
      const { wrapper, state, onApply } = setup()
      await wrapper.get('.calibration-toggle').trigger('click')
      state.timeSeconds = 10.5
      await wrapper.get('.capture-timing').trigger('click')
      if (change === 'offset') await wrapper.setProps({ offsetMs: 100 })
      else
        await wrapper.setProps({
          context: {
            ...context,
            ...(change === 'song'
              ? { trackId: 'other' }
              : change === 'source'
                ? { source: 'qq' as const }
                : { lines: [...context.lines] }),
          },
        })
      expect(wrapper.get('.calibration-toggle').attributes('aria-expanded')).toBe('false')
      expect(wrapper.get<HTMLButtonElement>('.apply-timing').element.disabled).toBe(true)
      expect(onApply).not.toHaveBeenCalled()
    },
  )

  it('cannot start without the currently resolved timed source', async () => {
    const { wrapper } = setup()
    await wrapper.setProps({ context: null })
    expect(wrapper.get<HTMLButtonElement>('.calibration-toggle').element.disabled).toBe(true)
  })
})
