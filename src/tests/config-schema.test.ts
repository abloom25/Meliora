import { describe, expect, it } from 'vitest'
import { validateMusicConfig } from '../../shared/config-schema'

const validConfig = {
  siteName: 'Meliora',
  apiEndpoint: 'https://api.example.com',
  playlists: [{ server: 'netease' as const, playlistId: '123' }],
  localTracks: [{ id: 'track-1', title: 'Song', artist: 'Artist', audio: '/music/track-1.mp3' }],
}

describe('validateMusicConfig', () => {
  it('accepts a valid complete config and returns cleaned config', () => {
    const result = validateMusicConfig(validConfig)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.config).toBeDefined()
    expect(result.config?.siteName).toBe('Meliora')
    expect(result.config?.apiEndpoint).toBe('https://api.example.com')
    expect(result.config?.playlists).toHaveLength(1)
    expect(result.config?.playlists[0].server).toBe('netease')
    expect(result.config?.localTracks).toHaveLength(1)
  })

  it('rejects missing siteName', () => {
    const result = validateMusicConfig({ ...validConfig, siteName: '' })
    expect(result.valid).toBe(false)
    expect(result.config).toBeUndefined()
    expect(result.errors.some((e) => e.includes('siteName'))).toBe(true)
  })

  it('rejects localhost apiEndpoint as internal address', () => {
    const result = validateMusicConfig({ ...validConfig, apiEndpoint: 'http://localhost:3000' })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('公网'))).toBe(true)
  })

  it('rejects IPv4-mapped IPv6 apiEndpoint as an internal-address bypass', () => {
    const result = validateMusicConfig({
      ...validConfig,
      apiEndpoint: 'http://[::ffff:127.0.0.1]/api',
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('公网'))).toBe(true)
  })

  it('accepts public https apiEndpoint', () => {
    const result = validateMusicConfig({ ...validConfig, apiEndpoint: 'https://api.example.com' })
    expect(result.valid).toBe(true)
  })

  it('accepts an empty apiEndpoint when no remote playlists are enabled', () => {
    const result = validateMusicConfig({
      ...validConfig,
      apiEndpoint: '',
      playlists: [],
    })
    expect(result.valid).toBe(true)
    expect(result.config?.apiEndpoint).toBe('')
  })

  it('rejects an empty apiEndpoint when a remote playlist is enabled', () => {
    const result = validateMusicConfig({ ...validConfig, apiEndpoint: '' })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('apiEndpoint'))).toBe(true)
  })

  it('rejects invalid playlist server', () => {
    const result = validateMusicConfig({
      ...validConfig,
      playlists: [{ server: 'foo', playlistId: '123' }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('server'))).toBe(true)
  })

  it('rejects empty playlistId', () => {
    const result = validateMusicConfig({
      ...validConfig,
      playlists: [{ server: 'netease', playlistId: '' }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('playlistId'))).toBe(true)
  })

  it('rejects empty localTrack audio', () => {
    const result = validateMusicConfig({
      ...validConfig,
      localTracks: [{ id: 't1', title: 'Song', artist: 'Artist', audio: '' }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('audio'))).toBe(true)
  })

  it('rejects null input', () => {
    const result = validateMusicConfig(null)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('配置必须是一个对象')
  })

  it('rejects array input', () => {
    const result = validateMusicConfig([1, 2, 3])
    expect(result.valid).toBe(false)
  })

  it('rejects string input', () => {
    const result = validateMusicConfig('not an object')
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('配置必须是一个对象')
  })

  it('remains valid when optional umami and googleAnalytics are missing', () => {
    const result = validateMusicConfig(validConfig)
    expect(result.valid).toBe(true)
    expect(result.config?.umami).toBeUndefined()
    expect(result.config?.googleAnalytics).toBeUndefined()
  })

  it('preserves optional umami and googleAnalytics when provided', () => {
    const result = validateMusicConfig({
      ...validConfig,
      umami: {
        enabled: true,
        scriptUrl: 'https://analytics.example.com/script.js',
        websiteId: 'abc',
      },
      googleAnalytics: { enabled: true, measurementId: 'G-XXXX' },
    })
    expect(result.valid).toBe(true)
    expect(result.config?.umami).toEqual({
      enabled: true,
      scriptUrl: 'https://analytics.example.com/script.js',
      websiteId: 'abc',
    })
    expect(result.config?.googleAnalytics).toEqual({ enabled: true, measurementId: 'G-XXXX' })
  })

  it('preserves receivePrereleaseUpdates when provided', () => {
    const result = validateMusicConfig({
      ...validConfig,
      receivePrereleaseUpdates: true,
    })

    expect(result.valid).toBe(true)
    expect(result.config?.receivePrereleaseUpdates).toBe(true)
  })

  it('rejects non-boolean receivePrereleaseUpdates', () => {
    const result = validateMusicConfig({
      ...validConfig,
      receivePrereleaseUpdates: 'yes',
    })

    expect(result.valid).toBe(false)
    expect(result.errors.some((error) => error.includes('receivePrereleaseUpdates'))).toBe(true)
  })
})
