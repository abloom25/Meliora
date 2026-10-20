import { describe, expect, it } from 'vitest'
import { createBeatAudioCache, type BeatAudioData } from '../platform/web/beat-audio-cache'

function pcm(samples = 4): BeatAudioData {
  return { channels: [new Float32Array(samples)], sampleRate: 48000 }
}

describe('bounded preanalysis audio cache', () => {
  it('does not let neighbouring PCM evict the current song and releases protection on track change', () => {
    const cache = createBeatAudioCache({ maxPcmBytes: 20 })
    const current = { ...pcm(), identity: 'content-a' }
    cache.protectPcm('current')
    cache.putPcm('current', current)
    cache.putPcm('next', pcm())
    expect(cache.takePcm('next')).toBeUndefined()
    expect(cache.takePcm('current')).toMatchObject({ identity: 'content-a' })
    cache.putPcm('current', current)
    cache.protectPcm('next')
    cache.putPcm('next', pcm())
    expect(cache.takePcm('current')).toBeUndefined()
    expect(cache.pcmBytes).toBe(16)
  })

  it('keeps the byte bound when the protected song returns after a neighbour', () => {
    const cache = createBeatAudioCache({ maxPcmBytes: 20 })
    cache.protectPcm('current')
    cache.putPcm('next', pcm())
    cache.putPcm('current', pcm())
    expect(cache.takePcm('next')).toBeUndefined()
    expect(cache.takePcm('current')).toBeDefined()
  })
  it('takes exclusive PCM ownership and never returns detached buffers', () => {
    const cache = createBeatAudioCache()
    const audio = pcm()
    cache.putPcm('a', audio)
    const taken = cache.takePcm('a')!
    expect(taken.channels[0]).toBe(audio.channels[0])
    expect(cache.takePcm('a')).toBeUndefined()
    expect(cache.pcmBytes).toBe(0)
    cache.putPcm('a', taken)
    structuredClone(taken.channels, { transfer: [taken.channels[0]!.buffer] })
    expect(cache.takePcm('a')).toBeUndefined()
    expect(cache.pcmEntries).toBe(0)
  })

  it('rejects detached returns without overwriting a valid worker-returned allocation', () => {
    const cache = createBeatAudioCache()
    const old = pcm()
    const returned = structuredClone(old, { transfer: [old.channels[0]!.buffer] })
    cache.putPcm('a', returned)
    cache.putPcm('a', old)
    expect(cache.takePcm('a')?.channels[0]).toBe(returned.channels[0])
  })

  it('bounds both retained bytes and entry count, refreshing reused PCM ownership', () => {
    const cache = createBeatAudioCache({ maxPcmBytes: 32, maxEntries: 2 })
    cache.putPcm('a', pcm())
    cache.putPcm('b', pcm())
    const a = cache.takePcm('a')!
    cache.putPcm('a', a)
    cache.putPcm('c', pcm())
    expect(cache.pcmBytes).toBe(32)
    expect(cache.pcmEntries).toBe(2)
    expect(cache.takePcm('b')).toBeUndefined()
    expect(cache.takePcm('a')).toBeDefined()
    cache.putPcm('large', pcm(9))
    expect(cache.pcmBytes).toBe(16)
    expect(cache.takePcm('c')).toBeDefined()
    expect(cache.takePcm('large')).toBeUndefined()
  })

  it('counts shared backing buffers once, including memory outside the channel views', () => {
    const cache = createBeatAudioCache({ maxPcmBytes: 32 })
    const buffer = new ArrayBuffer(32)
    const channels = [new Float32Array(buffer, 0, 2), new Float32Array(buffer, 8, 2)]
    cache.putPcm('a', { channels, sampleRate: 48000 })
    channels.length = 0
    expect(cache.pcmBytes).toBe(32)
    expect(cache.takePcm('a')?.channels).toHaveLength(2)
    const tooSmall = createBeatAudioCache({ maxPcmBytes: 16 })
    tooSmall.putPcm('a', { channels: [new Float32Array(buffer, 0, 2)], sampleRate: 48000 })
    expect(tooSmall.pcmEntries).toBe(0)
  })

  it('retains encoded copies across decoder input mutation and detachment', () => {
    const cache = createBeatAudioCache()
    const original = new Uint8Array([1, 2, 3]).buffer
    cache.putEncoded('a', original)
    new Uint8Array(original)[0] = 9
    structuredClone(original, { transfer: [original] })
    const first = cache.readEncoded('a')!
    expect([...new Uint8Array(first)]).toEqual([1, 2, 3])
    structuredClone(first, { transfer: [first] })
    expect([...new Uint8Array(cache.readEncoded('a')!)]).toEqual([1, 2, 3])
    expect(cache.encodedBytes).toBe(3)
  })

  it('evicts encoded data by bytes and LRU without clearing the independent PCM cache', () => {
    const cache = createBeatAudioCache({ maxEncodedBytes: 6, maxEntries: 2 })
    cache.putPcm('b', pcm())
    cache.putEncoded('a', new ArrayBuffer(3))
    cache.putEncoded('b', new ArrayBuffer(3))
    cache.readEncoded('a')
    cache.putEncoded('c', new ArrayBuffer(3))
    expect(cache.readEncoded('b')).toBeUndefined()
    expect(cache.takePcm('b')).toBeDefined()
    cache.putEncoded('oversized', new ArrayBuffer(7))
    expect(cache.encodedBytes).toBe(6)
    expect(cache.encodedEntries).toBe(2)
    cache.delete('a')
    expect(cache.encodedBytes).toBe(3)
    cache.clear()
    expect(cache.encodedEntries).toBe(0)
    expect(cache.pcmEntries).toBe(0)
  })

  it.each([
    { channels: [], sampleRate: 48000 },
    { channels: [new Float32Array(0)], sampleRate: 48000 },
    { channels: [new Float32Array(2), new Float32Array(3)], sampleRate: 48000 },
    { channels: [new Float32Array(2)], sampleRate: NaN },
    { channels: [new Float32Array(2)], sampleRate: 192001 },
  ])('does not retain malformed PCM %o', (audio) => {
    const cache = createBeatAudioCache()
    cache.putPcm('a', audio)
    expect(cache.pcmEntries).toBe(0)
  })

  it('supports disabling caches and rejects invalid limits', () => {
    const cache = createBeatAudioCache({ maxEntries: 0 })
    cache.putPcm('a', pcm())
    cache.putEncoded('a', new ArrayBuffer(4))
    expect(cache.pcmEntries + cache.encodedEntries).toBe(0)
    for (const value of [-1, NaN, Infinity, 0.5])
      expect(() => createBeatAudioCache({ maxPcmBytes: value })).toThrow('容量无效')
  })
})
