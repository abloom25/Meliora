import { describe, expect, it } from 'vitest'
import { validateMusicConfig } from '../../shared/config-schema'

const validConfig = {
  siteName: 'Meliora',
  apiEndpoint: 'https://api.example.com/api',
  playlists: [{ server: 'netease', playlistId: '123', enabled: true }],
  localTracks: [{ id: 'track-1', title: 'Song', artist: 'Artist', audio: '/music/track-1.mp3' }],
}

describe('config validation', () => {
  it('accepts a valid config', () => {
    const result = validateMusicConfig(validConfig)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects non-object input', () => {
    const result = validateMusicConfig('not an object')
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('配置必须是一个对象')
  })

  it('rejects null input', () => {
    const result = validateMusicConfig(null)
    expect(result.valid).toBe(false)
  })

  it('rejects missing siteName', () => {
    const result = validateMusicConfig({ ...validConfig, siteName: '' })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('siteName'))).toBe(true)
  })

  it('rejects missing apiEndpoint', () => {
    const result = validateMusicConfig({ ...validConfig, apiEndpoint: '' })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('apiEndpoint'))).toBe(true)
  })

  it('rejects non-array playlists', () => {
    const result = validateMusicConfig({ ...validConfig, playlists: 'not-array' })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('playlists 必须是数组'))).toBe(true)
  })

  it('rejects invalid server value', () => {
    const result = validateMusicConfig({
      ...validConfig,
      playlists: [{ server: 'spotify', playlistId: '123' }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('server'))).toBe(true)
  })

  it('rejects missing playlistId', () => {
    const result = validateMusicConfig({
      ...validConfig,
      playlists: [{ server: 'netease' }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('playlistId'))).toBe(true)
  })

  it('rejects non-array localTracks', () => {
    const result = validateMusicConfig({ ...validConfig, localTracks: 'not-array' })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('localTracks 必须是数组'))).toBe(true)
  })

  it('rejects localTrack missing audio', () => {
    const result = validateMusicConfig({
      ...validConfig,
      localTracks: [{ id: 't1', title: 'Song', artist: 'Artist' }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('audio'))).toBe(true)
  })

  it('rejects localTrack missing id', () => {
    const result = validateMusicConfig({
      ...validConfig,
      localTracks: [{ title: 'Song', artist: 'Artist', audio: '/x.mp3' }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('id'))).toBe(true)
  })

  it('accepts tencent server', () => {
    const result = validateMusicConfig({
      ...validConfig,
      playlists: [{ server: 'tencent', playlistId: '456' }],
    })
    expect(result.valid).toBe(true)
  })
})
