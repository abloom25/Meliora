import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import MusicSourceToggles from '../admin/components/MusicSourceToggles.vue'
import { loadConfiguredTracks } from '../services/music'
import { validateMusicConfig } from '../../shared/config-schema'
import type { MusicConfig, PublicMusicConfig } from '../../shared/music-config'
import {
  MUSIC_SOURCE_KINDS,
  findMusicSourceKind,
  isMusicSourceEnabled,
  musicSourceEntries,
  withMusicSourceEnabled,
} from '../../shared/music-sources'
import type { Track } from '../core/types'

function baseConfig(overrides: Partial<PublicMusicConfig> = {}): PublicMusicConfig {
  return {
    siteName: 'Meliora',
    apiEndpoint: 'https://api.example.com/api',
    playlists: [{ server: 'netease', playlistId: '1' }],
    localTracks: [{ id: 'a', title: 'A', artist: 'X', audio: '/a.mp3' }],
    ...overrides,
  }
}

function trackOf(id: string): Track {
  return { id, title: id, artist: 'X', audioUrl: `/${id}.mp3`, kind: 'local' }
}

function stubAdapters() {
  return {
    meting: { id: 'meting', load: vi.fn(async () => [trackOf('from-meting')]) },
    local: { id: 'local', load: vi.fn(async () => [trackOf('from-local')]) },
  } as never
}

describe('music source registry', () => {
  it('treats a source with no toggle recorded as enabled', () => {
    // 老配置里没有 sources 字段,升级不该把人家的曲库关掉
    const config = baseConfig()
    for (const kind of MUSIC_SOURCE_KINDS) {
      expect(isMusicSourceEnabled(config, kind.id)).toBe(true)
    }
  })

  it('reads each source entries through its declared field', () => {
    const config = baseConfig()
    const meting = findMusicSourceKind('meting')!
    const local = findMusicSourceKind('local')!
    expect(musicSourceEntries(config, meting)).toHaveLength(1)
    expect(musicSourceEntries(config, local)).toHaveLength(1)
    // 字段缺失时按空处理,而不是崩掉
    expect(musicSourceEntries({}, meting)).toEqual([])
  })

  it('flips one source without touching the others', () => {
    const config = withMusicSourceEnabled(baseConfig(), 'meting', false)
    expect(isMusicSourceEnabled(config, 'meting')).toBe(false)
    expect(isMusicSourceEnabled(config, 'local')).toBe(true)
    expect(config.playlists).toHaveLength(1)
  })

  it('does not know any source that is not registered', () => {
    expect(findMusicSourceKind('subsonic')).toBeNull()
  })
})

describe('loading with source toggles', () => {
  it('loads every registered source by default', async () => {
    const adapters = stubAdapters()
    const result = await loadConfiguredTracks(baseConfig(), { adapters })
    expect(result.tracks.map((track) => track.id).sort()).toEqual(['from-local', 'from-meting'])
  })

  it('skips a source that has been switched off but keeps its entries', async () => {
    const config = withMusicSourceEnabled(baseConfig(), 'meting', false)
    const adapters = stubAdapters()
    const result = await loadConfiguredTracks(config, { adapters })

    expect(result.tracks.map((track) => track.id)).toEqual(['from-local'])
    // 关掉只是不加载,配置里的歌单还在
    expect(config.playlists).toHaveLength(1)
  })

  it('still honours the per-entry switch inside an enabled source', async () => {
    const config = baseConfig({
      playlists: [{ server: 'netease', playlistId: '1', enabled: false }],
    })
    const result = await loadConfiguredTracks(config, { adapters: stubAdapters() })
    expect(result.tracks.map((track) => track.id)).toEqual(['from-local'])
  })
})

describe('config validation for source toggles', () => {
  function validate(config: Partial<MusicConfig>) {
    return validateMusicConfig({ ...baseConfig(), ...config } as MusicConfig)
  }

  it('accepts a toggle map that only names registered sources', () => {
    expect(validate({ sources: { meting: { enabled: false } } }).valid).toBe(true)
  })

  // 只断言 valid 是不够的:校验通过但开关没被写进 cleaned 的话,
  // 后台会保存「成功」而配置里没有这张表,前端按缺省当作开启,开关等于白点
  it('carries the toggle map into the cleaned config that gets persisted', () => {
    const result = validate({ sources: { meting: { enabled: false }, local: { enabled: true } } })
    expect(result.valid).toBe(true)
    expect(result.config?.sources).toEqual({
      meting: { enabled: false },
      local: { enabled: true },
    })
  })

  it('rejects a toggle for a source nobody registered', () => {
    const result = validate({ sources: { subsonic: { enabled: true } } })
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toContain('subsonic')
  })

  it('rejects a non-boolean switch', () => {
    const result = validate({ sources: { meting: { enabled: 'yes' } } as never })
    expect(result.valid).toBe(false)
  })

  it('stops demanding an api endpoint once remote playlists are switched off', () => {
    // 音源关掉后整类都不会加载,再强制要求 apiEndpoint 就没有道理了
    const withEndpoint = validate({ apiEndpoint: '' })
    expect(withEndpoint.valid).toBe(false)

    const switchedOff = validate({ apiEndpoint: '', sources: { meting: { enabled: false } } })
    expect(switchedOff.valid).toBe(true)
  })
})

describe('admin source toggles', () => {
  it('lists every registered source with its entry count', () => {
    const wrapper = mount(MusicSourceToggles, { props: { config: baseConfig() } })
    const rows = wrapper.findAll('.setting-row')

    expect(rows).toHaveLength(MUSIC_SOURCE_KINDS.length)
    for (const [index, kind] of MUSIC_SOURCE_KINDS.entries()) {
      expect(rows[index]!.text()).toContain(kind.label)
    }
    expect(wrapper.text()).toContain('已配置 1 个歌单')
    expect(wrapper.text()).toContain('已配置 1 首歌曲')
    wrapper.unmount()
  })

  it('emits a config with only that source switched off', async () => {
    const wrapper = mount(MusicSourceToggles, { props: { config: baseConfig() } })

    await wrapper
      .findAllComponents({ name: 'ToggleSwitch' })[0]!
      .vm.$emit('update:modelValue', false)

    const emitted = wrapper.emitted('update:config')?.at(-1)?.[0] as PublicMusicConfig
    expect(isMusicSourceEnabled(emitted, 'meting')).toBe(false)
    expect(isMusicSourceEnabled(emitted, 'local')).toBe(true)
    wrapper.unmount()
  })

  it('shows a note next to a source that is off', () => {
    const config = withMusicSourceEnabled(baseConfig(), 'local', false)
    const wrapper = mount(MusicSourceToggles, { props: { config } })
    expect(wrapper.text()).toContain('当前未启用')
    wrapper.unmount()
  })
})
