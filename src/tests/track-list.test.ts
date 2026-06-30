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
        spectrumLevels: [0.1, 0.1, 0.1, 0.1],
      },
    })

    expect(wrapper.find('.track-virtual-spacer').attributes('style')).toContain('height: 7920px')
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
        spectrumLevels: [0.1, 0.1, 0.1, 0.1],
      },
    })

    expect(wrapper.find('.track-virtual-spacer').exists()).toBe(false)
    expect(wrapper.find('.list-state').text()).toContain('暂无歌曲')
  })
})
