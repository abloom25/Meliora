import { describe, expect, it } from 'vitest'
import { createMetingTrackId, normalizeTrackId } from '../core/library/track-id'
import {
  listeningTrackKey,
  normalizeListeningKey,
  sanitizeListeningRecords,
} from '../core/playback/listening-stats'
import { sanitizeFavoriteKeys } from '../core/library/personal-library'

describe('stable track identities', () => {
  it('normalizes persisted legacy IDs without a loaded playlist', () => {
    const legacy =
      'meting:netease:playlist:12:https://api.test:8443/music?server=netease&type=url&id=42&token=old'
    const stable = 'meting:v2:netease:song:42'
    expect(normalizeTrackId(legacy)).toBe(stable)
    expect(normalizeTrackId(stable)).toBe(stable)
    expect(normalizeTrackId('local:42')).toBe('local:42')
    expect(normalizeTrackId('meting:invalid')).toBe('meting:invalid')
    expect(
      normalizeTrackId('meting:tencent:playlist:1:/api?server=qq&type=lrc&songmid=00A%2BB'),
    ).toBe('meting:v2:tencent:song:00A%2BB')
    expect(normalizeTrackId('meting:netease:playlist:1:/audio/live.mp3')).toBe(
      createMetingTrackId('netease:playlist', '/audio/live.mp3'),
    )
  })

  it('does not mistake ambiguous IDs, playlist IDs or unrelated platforms for song IDs', () => {
    const resource = (url: string) => createMetingTrackId('netease:playlist', url)
    expect(resource('/api?id=1&id=2')).toContain(':resource:')
    expect(resource('/api?id=1&type=playlist')).toContain(':resource:')
    expect(resource('/api?id=1&server=unknown')).toContain(':resource:')
    expect(resource('/cdn?id=1')).toContain(':resource:')
    expect(resource('/api?id=1&server=netease&server=tencent')).toContain(':resource:')
    expect(resource('/api?id=%FF')).toContain(':resource:')
    expect(resource('/api?server=netease&id=\ud800')).toContain(':resource:')
    expect(resource('/api?id=1')).not.toBe(createMetingTrackId('tencent:playlist', '/api?id=1'))
  })

  it('migrates and merges old history while preserving total listening and latest display metadata', () => {
    const oldId = (index: number) => `meting:netease:playlist:${index}:/audio?server=netease&id=42`
    const key = (index: number) => JSON.stringify(['meting', oldId(index)])
    const stableKey = listeningTrackKey({ kind: 'meting', id: 'meting:v2:netease:song:42' })
    const record = (index: number) => ({
      key: key(index),
      title: `Title ${index}`,
      artist: 'Singer',
      qualifiedPlays: 2,
      listenedSeconds: 60,
      lastPlayedAt: index,
    })
    const result = sanitizeListeningRecords([record(1), record(2), record(2)])
    expect(result).toEqual([
      { ...record(2), key: stableKey, qualifiedPlays: 4, listenedSeconds: 120 },
    ])
    expect(normalizeListeningKey(key(1))).toBe(stableKey)
    expect(sanitizeFavoriteKeys([key(1), key(2), stableKey])).toEqual([stableKey])
  })
})
