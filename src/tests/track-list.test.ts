import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import TrackList from '../components/TrackList.vue'
import type { Track } from '../types/music'

function makeTracks(count: number): Track[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${index + 1}`,
    title: `Track ${index + 1}`,
    artist: 'Artist',
    audioUrl: `/${index + 1}.mp3`,
    kind: 'local',
  }))
}

describe('TrackList', () => {
  it('uses the full virtual list height as the scrollable spacer', () => {
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    })

    const wrapper = mount(TrackList, {
      props: {
        tracks: makeTracks(120),
        total: 120,
        currentTrackId: null,
        isPlaying: false,
        loading: false,
        query: '',
      },
    })

    expect(wrapper.find('.track-virtual-spacer').attributes('style')).toContain('height: 7920px')
  })

  it('positions virtual items at multiples of the fixed 66px item height', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    })

    const wrapper = mount(TrackList, {
      props: {
        tracks: makeTracks(120),
        total: 120,
        currentTrackId: null,
        isPlaying: false,
        loading: false,
        query: '',
      },
    })

    const items = wrapper.findAll('.track-item')
    expect(items.length).toBeGreaterThan(2)
    items.forEach((item, index) => {
      expect(item.attributes('style')).toContain(`top: ${index * 66}px`)
    })
  })

  it('does not render a full-height virtual spacer before the empty state', () => {
    const wrapper = mount(TrackList, {
      props: {
        tracks: [],
        total: 0,
        currentTrackId: null,
        isPlaying: false,
        loading: false,
        query: '',
      },
    })

    expect(wrapper.find('.track-virtual-spacer').exists()).toBe(false)
    expect(wrapper.find('.list-state').text()).toContain('暂无歌曲')
  })

  it('renders five spectrum bars for the playing track and exposes the meter element', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    })

    const wrapper = mount(TrackList, {
      props: {
        tracks: makeTracks(20),
        total: 20,
        currentTrackId: '2',
        isPlaying: true,
        loading: false,
        query: '',
      },
    })

    const meter = wrapper.find('.spectrum-meter')
    expect(meter.exists()).toBe(true)
    expect(meter.findAll('i')).toHaveLength(5)
    const exposed = wrapper.vm as unknown as { spectrumMeter: HTMLElement | null }
    expect(exposed.spectrumMeter).toBe(meter.element)
  })

  it('falls back to the track number when spectrum analysis is unavailable', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    })

    const wrapper = mount(TrackList, {
      props: {
        tracks: makeTracks(20),
        total: 20,
        currentTrackId: '2',
        isPlaying: true,
        loading: false,
        query: '',
        spectrumAvailable: false,
      },
    })

    expect(wrapper.find('.spectrum-meter').exists()).toBe(false)
    const rows = wrapper.findAll('.track-status')
    expect(rows[1]?.text()).toBe('2')
  })
})
