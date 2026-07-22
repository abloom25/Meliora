import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  clampGain,
  normalizeBands,
  isValidPreset,
  sanitizeEqualizer,
  bandsMatchPreset,
  detectPreset,
  bandFilterType,
  createDefaultEqualizer,
  EQ_MIN_GAIN,
  EQ_MAX_GAIN,
  EQ_BAND_COUNT,
  EQ_PRESETS,
  EQ_APPLICABLE_PRESETS,
} from '../../utils/equalizer'
import type { EqPresetId } from '../../types/music'

describe('clampGain 边界与幂等', () => {
  it('NaN -> 0', () => expect(clampGain(NaN)).toBe(0))
  it('+Infinity -> 最大增益', () => expect(clampGain(Infinity)).toBe(EQ_MAX_GAIN))
  it('-Infinity -> 最小增益', () => expect(clampGain(-Infinity)).toBe(EQ_MIN_GAIN))
  it('有限值恒在范围内且幂等', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true }), (x) => {
        const c = clampGain(x)
        expect(c).toBeGreaterThanOrEqual(EQ_MIN_GAIN)
        expect(c).toBeLessThanOrEqual(EQ_MAX_GAIN)
        expect(clampGain(c)).toBe(c)
      }),
    )
  })
})

describe('normalizeBands', () => {
  it('非数组回落为 flat 预设', () => {
    expect(normalizeBands(undefined)).toEqual([...EQ_PRESETS.flat.bands])
    expect(normalizeBands('nope')).toEqual([...EQ_PRESETS.flat.bands])
  })
  it('长度恒为 EQ_BAND_COUNT 且每项有限并在范围内', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.double(), fc.string(), fc.constant(null))), (raw) => {
        const out = normalizeBands(raw)
        expect(out).toHaveLength(EQ_BAND_COUNT)
        out.forEach((v) => {
          expect(Number.isFinite(v)).toBe(true)
          expect(v).toBeGreaterThanOrEqual(EQ_MIN_GAIN)
          expect(v).toBeLessThanOrEqual(EQ_MAX_GAIN)
        })
      }),
    )
  })
  it('非数字项归零', () => {
    expect(normalizeBands([NaN, 'a', null, undefined, {}])).toEqual([0, 0, 0, 0, 0])
  })
})

describe('isValidPreset', () => {
  it('已知预设 id 为 true，其余为 false', () => {
    ;(Object.keys(EQ_PRESETS) as EqPresetId[]).forEach((id) =>
      expect(isValidPreset(id)).toBe(true),
    )
    expect(isValidPreset('nope')).toBe(false)
    expect(isValidPreset(123)).toBe(false)
    expect(isValidPreset(undefined)).toBe(false)
  })
})

describe('detectPreset / bandsMatchPreset 往返自洽', () => {
  it('每个可应用预设的 bands 都能被识别回自身', () => {
    EQ_APPLICABLE_PRESETS.forEach((p) => {
      expect(bandsMatchPreset(p.bands, p.id)).toBe(true)
      expect(detectPreset(p.bands)).toBe(p.id)
    })
  })
  it('无匹配的 bands 回落到 custom', () => {
    expect(detectPreset([11, -7, 5, -3, 9])).toBe('custom')
  })
})

describe('sanitizeEqualizer', () => {
  it('非法 preset 回落 flat；输出 bands 长度与范围合法', () => {
    fc.assert(
      fc.property(
        fc.record({
          enabled: fc.anything(),
          preset: fc.anything(),
          bands: fc.anything(),
        }),
        (input) => {
          const out = sanitizeEqualizer(input as never)
          expect(isValidPreset(out.preset)).toBe(true)
          expect(out.bands).toHaveLength(EQ_BAND_COUNT)
          expect(typeof out.enabled).toBe('boolean')
        },
      ),
    )
  })
  it('undefined 输入产生 flat 默认', () => {
    const out = sanitizeEqualizer(undefined)
    expect(out.preset).toBe('flat')
    expect(out.enabled).toBe(false)
  })
})

describe('bandFilterType', () => {
  it('首端 lowshelf、尾端 highshelf、中间 peaking', () => {
    expect(bandFilterType(0)).toBe('lowshelf')
    expect(bandFilterType(EQ_BAND_COUNT - 1)).toBe('highshelf')
    expect(bandFilterType(2)).toBe('peaking')
  })
})

describe('createDefaultEqualizer', () => {
  it('默认关闭、flat、bands 为 flat 拷贝', () => {
    const d = createDefaultEqualizer()
    expect(d.enabled).toBe(false)
    expect(d.preset).toBe('flat')
    expect(d.bands).toEqual([...EQ_PRESETS.flat.bands])
    expect(d.bands).not.toBe(EQ_PRESETS.flat.bands) // 深拷贝
  })
})
