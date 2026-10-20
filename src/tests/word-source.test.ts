import { describe, expect, it } from 'vitest'
import { normalizeLyricsMetadata, selectWordLyricsCandidate } from '../core/lyrics/word-source'

describe('conservative word lyrics matching', () => {
  const candidate = {
    id: 1,
    musicNames: ['Hello (Live)'],
    artistNames: ['A', 'B'],
    albumNames: ['Live'],
  }

  it('normalizes width and whitespace but keeps recording-version punctuation', () => {
    expect(normalizeLyricsMetadata('  ＨＥＬＬＯ   (Live) ')).toBe('hello (live)')
    expect(normalizeLyricsMetadata('Hello (Live)')).not.toBe(normalizeLyricsMetadata('Hello'))
  })

  it('requires the full artist set and the supplied album', () => {
    expect(
      selectWordLyricsCandidate([candidate], {
        title: 'Hello (Live)',
        artist: 'B / A',
        album: 'Live',
      }),
    ).toBe(candidate)
    expect(
      selectWordLyricsCandidate([candidate], { title: 'Hello (Live)', artist: 'A' }),
    ).toBeNull()
    expect(
      selectWordLyricsCandidate([candidate], {
        title: 'Hello (Live)',
        artist: 'A / B',
        album: 'Studio',
      }),
    ).toBeNull()
  })

  it('does not strip slashes or commas embedded in artist names', () => {
    const band = { ...candidate, artistNames: ['AC/DC'] }
    expect(selectWordLyricsCandidate([band], { title: 'Hello (Live)', artist: 'AC/DC' })).toBe(band)
    expect(
      selectWordLyricsCandidate([band], { title: 'Hello (Live)', artist: 'AC / DC' }),
    ).toBeNull()
  })

  it('rejects two exact matches even when one is listed first', () => {
    expect(
      selectWordLyricsCandidate([candidate, { ...candidate, id: 2 }], {
        title: 'Hello (Live)',
        artist: 'A / B',
      }),
    ).toBeNull()
  })
})
