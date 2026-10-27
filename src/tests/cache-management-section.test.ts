import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CacheManagementSection from '../components/CacheManagementSection.vue'
import { useCacheManagement } from '../composables/useCacheManagement'

vi.mock('../composables/useCacheManagement', () => ({ useCacheManagement: vi.fn() }))

function fixture() {
  return {
    loading: ref(false),
    busy: ref(''),
    error: ref(''),
    lyrics: ref({ entries: 3, bytes: 512, storageAvailable: true }),
    modelBytes: ref({ small: 1000000, standard: 0, runtime: 123000 }),
    models: ref({ small: { phase: 'ready' }, standard: { phase: 'missing' } }),
    beat: ref({
      cachedTracks: 1,
      cacheBytes: 1200,
      maxBytes: 32 * 1024 * 1024,
      storageAvailable: true,
    }),
    tracks: ref([
      {
        track: 'song',
        title: '测试歌曲',
        artist: '歌手',
        bytes: 1200,
        pinned: false,
        current: true,
      },
    ]),
    clearLyrics: vi.fn(),
    clearBeats: vi.fn(),
    removeModel: vi.fn(),
    removeTrack: vi.fn(),
    pinTrack: vi.fn(),
    setBudget: vi.fn(),
  }
}
let state: ReturnType<typeof fixture>
beforeEach(() => {
  state = fixture()
  vi.mocked(useCacheManagement).mockReturnValue(
    state as unknown as ReturnType<typeof useCacheManagement>,
  )
})

describe('cache management settings', () => {
  it('requires confirmation for a category clear and keeps categories independent', async () => {
    const wrapper = mount(CacheManagementSection)
    const clear = wrapper.findAll('button').find((button) => button.text() === '清除歌词缓存')!
    await clear.trigger('click')
    expect(state.clearLyrics).not.toHaveBeenCalled()
    await clear.trigger('click')
    expect(state.clearLyrics).toHaveBeenCalledOnce()
    expect(state.clearBeats).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('听歌统计')
    wrapper.unmount()
  })

  it('offers per-song pinning and deletion without clearing the rest of the cache', async () => {
    const wrapper = mount(CacheManagementSection)
    await wrapper.get('.cache-list-toggle').trigger('click')
    await wrapper.get('[aria-label="固定缓存：测试歌曲"]').trigger('click')
    expect(state.pinTrack).toHaveBeenCalledWith('song', true)
    await wrapper.get('[aria-label="清除节拍缓存：测试歌曲"]').trigger('click')
    expect(state.removeTrack).toHaveBeenCalledWith('song')
    expect(state.clearBeats).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('shows a nonempty loading placeholder and disables destructive controls while busy', async () => {
    state.loading.value = true
    const wrapper = mount(CacheManagementSection)
    expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe('正在读取缓存占用')
    state.loading.value = false
    state.busy.value = 'lyrics'
    await wrapper.vm.$nextTick()
    expect(
      wrapper
        .findAll('.section-reset')
        .every((button) => button.attributes('disabled') !== undefined),
    ).toBe(true)
    wrapper.unmount()
  })
})
