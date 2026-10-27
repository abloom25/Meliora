import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCacheManagement } from '../composables/useCacheManagement'

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  clear: vi.fn(),
  clearLyrics: vi.fn(),
  stats: vi.fn(),
  initialize: vi.fn(),
  savedBytes: vi.fn(),
  removeModel: vi.fn(),
  resetWords: vi.fn(),
  resetNative: vi.fn(),
  resetTracks: vi.fn(),
  player: {
    settings: { beatAnalysisMode: 'beat-this-small' },
    tracks: [{ id: 'song', kind: 'local', title: '曲库歌曲', artist: '歌手' }],
  },
}))
vi.mock('../platform/web/beat-result-cache', async () => {
  const { ref } = await import('vue')
  return {
    beatResultCache: {
      store: { refresh: mocks.refresh, clear: mocks.clear },
      status: ref({
        entries: [{ key: 'result', track: '["local","song"]', bytes: 1, updatedAt: 1 }],
        storageAvailable: true,
        maxBytes: 32 * 1024 * 1024,
      }),
    },
  }
})
vi.mock('../platform/web/lyrics-cache', () => ({
  webLyricsCacheStore: { stats: mocks.stats, clear: mocks.clearLyrics },
}))
vi.mock('../platform/web/listening-history', async () => ({
  listeningStatsSummary: (await import('vue')).ref({ trackedTracks: [] }),
}))
vi.mock('../platform/web/useBeatThisModels', async () => {
  const status = (await import('vue')).ref({
    small: { phase: 'ready' },
    standard: { phase: 'missing' },
  })
  return {
    useBeatThisModels: () => ({
      status,
      initialize: mocks.initialize,
      savedBytes: mocks.savedBytes,
      remove: mocks.removeModel,
    }),
  }
})
vi.mock('../stores/player', () => ({ usePlayerStore: () => mocks.player }))
vi.mock('../services/lyrics-db', () => ({ resetWordLyricsCache: mocks.resetWords }))
vi.mock('../services/native-lyrics', () => ({ resetNativeLyricsCache: mocks.resetNative }))
vi.mock('../services/lyrics', () => ({ resetTrackLyricsCache: mocks.resetTracks }))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.savedBytes.mockResolvedValue({ small: 10, standard: 0, runtime: 2 })
  mocks.stats.mockResolvedValue({ entries: 1, bytes: 100, storageAvailable: true })
  mocks.player.settings.beatAnalysisMode = 'beat-this-small'
})

function setup() {
  let management!: ReturnType<typeof useCacheManagement>
  const wrapper = mount(
    defineComponent({
      setup() {
        management = useCacheManagement(ref(null))
        return () => h('div')
      },
    }),
  )
  return { management, wrapper }
}

describe('cache management orchestration', () => {
  it('keeps songs identifiable without listening history and removes an active model through basic mode', async () => {
    const { management, wrapper } = setup()
    await flushPromises()
    expect(management.tracks.value[0]?.title).toBe('曲库歌曲')
    await management.removeModel('small')
    expect(mocks.player.settings.beatAnalysisMode).toBe('basic')
    expect(mocks.removeModel).toHaveBeenCalledWith('small')
    wrapper.unmount()
  })
  it('clears all lyric memory tiers without deleting analysis caches', async () => {
    const { management, wrapper } = setup()
    await flushPromises()
    await management.clearLyrics()
    expect(mocks.resetWords).toHaveBeenCalledOnce()
    expect(mocks.resetNative).toHaveBeenCalledOnce()
    expect(mocks.resetTracks).toHaveBeenCalledOnce()
    expect(mocks.clearLyrics).toHaveBeenCalledOnce()
    expect(mocks.clear).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('handles synchronous inventory failures and preserves actionable operation errors', async () => {
    mocks.savedBytes.mockImplementation(() => {
      throw new Error('denied')
    })
    const { management, wrapper } = setup()
    await flushPromises()
    expect(management.loading.value).toBe(false)
    expect(management.error.value).toBe('部分缓存占用暂时无法读取，请稍后重试')
    mocks.clearLyrics.mockRejectedValue(new Error('歌词缓存未能清除，请重试'))
    await management.clearLyrics()
    expect(management.error.value).toBe('歌词缓存未能清除，请重试')
    expect(management.busy.value).toBe('')
    wrapper.unmount()
  })
})
