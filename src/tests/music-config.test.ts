import { afterEach, describe, expect, it, vi } from 'vitest'
import { musicConfig, resolveMusicRequestUrl, setMusicConfig } from '../config/music'

vi.mock('../generated/public-config', () => ({
  publicMusicConfig: {
    siteName: 'Meliora',
    apiEndpoint: 'https://original.example/api',
    playlists: [],
    localTracks: [],
  },
}))

afterEach(() => {
  setMusicConfig(null)
  vi.unstubAllEnvs()
})

describe('runtime music configuration with the development proxy', () => {
  it('replaces and restores runtime config without changing the fixed Vite proxy target', () => {
    vi.stubEnv('DEV', true)
    const original = musicConfig()
    const replacement = { ...original, apiEndpoint: 'https://replacement.example/api' }
    setMusicConfig(replacement)
    expect(musicConfig()).toBe(replacement)
    expect(resolveMusicRequestUrl(`${replacement.apiEndpoint}?type=playlist&id=1`)).toBe(
      'https://replacement.example/api?type=playlist&id=1',
    )
    expect(resolveMusicRequestUrl(`${original.apiEndpoint}?type=url&id=1`)).toBe(
      '/__meliora-dev/music/api?type=url&id=1',
    )
    setMusicConfig(null)
    expect(musicConfig()).toBe(original)
  })

  it('preserves all resource URLs in production', () => {
    vi.stubEnv('DEV', false)
    const url = `${musicConfig().apiEndpoint}?type=url&id=1`
    expect(resolveMusicRequestUrl(url)).toBe(url)
  })
})
