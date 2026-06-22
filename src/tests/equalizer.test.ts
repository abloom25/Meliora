import { describe, expect, it } from 'vitest'
import {
  EQ_APPLICABLE_PRESETS,
  EQ_BAND_COUNT,
  EQ_BAND_FREQUENCIES,
  EQ_MAX_GAIN,
  EQ_MIN_GAIN,
  EQ_PRESETS,
  EQ_PRESET_LIST,
  bandFilterType,
  bandsMatchPreset,
  clampGain,
  createDefaultEqualizer,
  detectPreset,
  isValidPreset,
  normalizeBands,
  sanitizeEqualizer,
} from '../utils/equalizer'

describe('equalizer constants', () => {
  it('exposes five bands matching the frequency list', () => {
    expect(EQ_BAND_FREQUENCIES).toHaveLength(5)
    expect(EQ_BAND_COUNT).toBe(5)
  })

  it('provides six applicable presets plus a custom status indicator', () => {
    expect(EQ_APPLICABLE_PRESETS).toHaveLength(6)
    expect(EQ_APPLICABLE_PRESETS.every((preset) => preset.id !== 'custom')).toBe(true)
    expect(EQ_PRESET_LIST).toHaveLength(7)
    expect(EQ_PRESET_LIST[EQ_PRESET_LIST.length - 1].id).toBe('custom')
    for (const preset of EQ_PRESET_LIST) {
      expect(preset.bands).toHaveLength(EQ_BAND_COUNT)
    }
  })

  it('exposes a custom preset entry with flat zero bands', () => {
    expect(EQ_PRESETS.custom.id).toBe('custom')
    expect(EQ_PRESETS.custom.bands).toEqual([0, 0, 0, 0, 0])
  })
})

describe('createDefaultEqualizer', () => {
  it('returns disabled flat equalizer with zero gains', () => {
    const eq = createDefaultEqualizer()
    expect(eq.enabled).toBe(false)
    expect(eq.preset).toBe('flat')
    expect(eq.bands).toEqual([0, 0, 0, 0, 0])
  })

  it('returns a fresh array reference each call', () => {
    const a = createDefaultEqualizer()
    const b = createDefaultEqualizer()
    expect(a.bands).not.toBe(b.bands)
  })
})

describe('clampGain', () => {
  it('clamps values to the valid gain range', () => {
    expect(clampGain(0)).toBe(0)
    expect(clampGain(EQ_MAX_GAIN)).toBe(EQ_MAX_GAIN)
    expect(clampGain(EQ_MIN_GAIN)).toBe(EQ_MIN_GAIN)
    expect(clampGain(EQ_MAX_GAIN + 5)).toBe(EQ_MAX_GAIN)
    expect(clampGain(EQ_MIN_GAIN - 5)).toBe(EQ_MIN_GAIN)
  })

  it('normalizes non-finite values to zero', () => {
    expect(clampGain(Number.NaN)).toBe(0)
    expect(clampGain(Number.POSITIVE_INFINITY)).toBe(EQ_MAX_GAIN)
    expect(clampGain(Number.NEGATIVE_INFINITY)).toBe(EQ_MIN_GAIN)
  })
})

describe('isValidPreset', () => {
  it('accepts known preset ids including custom', () => {
    expect(isValidPreset('flat')).toBe(true)
    expect(isValidPreset('bass-boost')).toBe(true)
    expect(isValidPreset('custom')).toBe(true)
  })

  it('rejects unknown ids and non-strings', () => {
    expect(isValidPreset('unknown')).toBe(false)
    expect(isValidPreset(123)).toBe(false)
    expect(isValidPreset(null)).toBe(false)
    expect(isValidPreset(undefined)).toBe(false)
  })
})

describe('normalizeBands', () => {
  it('returns flat bands for non-array input', () => {
    expect(normalizeBands(null)).toEqual([0, 0, 0, 0, 0])
    expect(normalizeBands(undefined)).toEqual([0, 0, 0, 0, 0])
    expect(normalizeBands('not-an-array')).toEqual([0, 0, 0, 0, 0])
  })

  it('clamps each band and pads missing slots with zero', () => {
    expect(normalizeBands([20, -20, 3])).toEqual([EQ_MAX_GAIN, EQ_MIN_GAIN, 3, 0, 0])
  })

  it('ignores extra elements beyond band count', () => {
    expect(normalizeBands([1, 2, 3, 4, 5, 6, 7])).toEqual([1, 2, 3, 4, 5])
  })

  it('coerces non-numeric entries to zero', () => {
    expect(normalizeBands(['a', null, undefined, true, false])).toEqual([0, 0, 0, 0, 0])
  })
})

describe('sanitizeEqualizer', () => {
  it('returns full defaults for undefined input', () => {
    const eq = sanitizeEqualizer(undefined)
    expect(eq).toEqual(createDefaultEqualizer())
  })

  it('preserves valid fields and fixes invalid ones', () => {
    const eq = sanitizeEqualizer({
      enabled: true,
      preset: 'rock',
      bands: [4, 2, -1, 2, 3],
    })
    expect(eq.enabled).toBe(true)
    expect(eq.preset).toBe('rock')
    expect(eq.bands).toEqual([4, 2, -1, 2, 3])
  })

  it('falls back to flat preset for unknown id', () => {
    const eq = sanitizeEqualizer({ preset: 'unknown' as never })
    expect(eq.preset).toBe('flat')
  })

  it('preserves custom preset id from persisted settings', () => {
    const eq = sanitizeEqualizer({ preset: 'custom', bands: [3, 1, 0, -2, 5] })
    expect(eq.preset).toBe('custom')
    expect(eq.bands).toEqual([3, 1, 0, -2, 5])
  })

  it('repairs malformed bands array', () => {
    const eq = sanitizeEqualizer({ bands: [99, 'x', null] as unknown as number[] })
    expect(eq.bands).toEqual([EQ_MAX_GAIN, 0, 0, 0, 0])
  })
})

describe('bandsMatchPreset', () => {
  it('matches when bands equal a preset exactly', () => {
    expect(bandsMatchPreset([0, 0, 0, 0, 0], 'flat')).toBe(true)
    expect(bandsMatchPreset([4, 2, -1, 2, 3], 'rock')).toBe(true)
  })

  it('rejects when any band differs', () => {
    expect(bandsMatchPreset([1, 0, 0, 0, 0], 'flat')).toBe(false)
    expect(bandsMatchPreset([4, 2, -1, 2, 4], 'rock')).toBe(false)
  })
})

describe('detectPreset', () => {
  it('detects the matching applicable preset for exact band values', () => {
    for (const preset of EQ_APPLICABLE_PRESETS) {
      expect(detectPreset([...preset.bands])).toBe(preset.id)
    }
  })

  it('falls back to custom for unmatched band combinations', () => {
    expect(detectPreset([1, 2, 3, 4, 5])).toBe('custom')
    expect(detectPreset([0, 0, 0, 0, 1])).toBe('custom')
  })

  it('never returns custom when bands exactly match flat preset', () => {
    expect(detectPreset([0, 0, 0, 0, 0])).toBe('flat')
  })
})

describe('bandFilterType', () => {
  it('uses lowshelf for the first band (bass control)', () => {
    expect(bandFilterType(0)).toBe('lowshelf')
  })

  it('uses highshelf for the last band (treble control)', () => {
    expect(bandFilterType(EQ_BAND_COUNT - 1)).toBe('highshelf')
  })

  it('uses peaking for intermediate bands', () => {
    expect(bandFilterType(1)).toBe('peaking')
    expect(bandFilterType(2)).toBe('peaking')
    expect(bandFilterType(3)).toBe('peaking')
  })
})
