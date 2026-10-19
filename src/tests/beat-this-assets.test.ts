/// <reference types="node" />

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BEAT_THIS_FILTERBANK, BEAT_THIS_MODELS } from '../core/analysis/beat-this-models'
import { BEAT_THIS_PROBES } from '../core/analysis/beat-this-probes'
import manifest from '../../public/models/beat-this/manifest.json'
import smallFixture from './fixtures/beat-this-small-parity.json'
import standardFixture from './fixtures/beat-this-standard-parity.json'

describe('published Beat This! model assets', () => {
  it.each(['small', 'standard'] as const)('ships complete verified static parts for %s', (id) => {
    const asset = BEAT_THIS_MODELS[id]
    const entry = manifest.models.find((model) => model.id === id)!
    const digest = createHash('sha256')
    let total = 0
    for (const part of asset.parts) {
      const bytes = readFileSync(`public${part.url}`)
      expect(bytes.byteLength).toBe(part.bytes)
      expect(bytes.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(part.sha256)
      digest.update(bytes)
      total += bytes.byteLength
    }
    expect(total).toBe(entry.bytes)
    expect(digest.digest('hex')).toBe(entry.sha256)
    expect(total + BEAT_THIS_FILTERBANK.bytes).toBe(asset.downloadBytes)
    expect(asset.parts).toEqual(entry.parts)
  })

  it('publishes the exact reference filterbank and backend correctness probes', () => {
    const filterbank = readFileSync(`public${BEAT_THIS_FILTERBANK.url}`)
    expect(filterbank.byteLength).toBe(513 * 128 * Float32Array.BYTES_PER_ELEMENT)
    expect(createHash('sha256').update(filterbank).digest('hex')).toBe(BEAT_THIS_FILTERBANK.sha256)
    expect(manifest.filterbank).toEqual(BEAT_THIS_FILTERBANK)
    for (const [id, fixture] of [
      ['small', smallFixture],
      ['standard', standardFixture],
    ] as const) {
      expect(fixture.indices).toEqual(Array.from({ length: 32 }, (_, index) => index * 47))
      expect(BEAT_THIS_PROBES[id].beat).toEqual(fixture.beat)
      expect(BEAT_THIS_PROBES[id].downbeat).toEqual(fixture.downbeat)
    }
  })
})
