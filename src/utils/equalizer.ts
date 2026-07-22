import type { EqualizerSettings, EqPresetId } from '../types/music'

export const EQ_BAND_FREQUENCIES = [60, 250, 1000, 4000, 12000] as const
export const EQ_BAND_COUNT = EQ_BAND_FREQUENCIES.length
export const EQ_MIN_GAIN = -12
export const EQ_MAX_GAIN = 12

export const EQ_BAND_LABELS = ['60Hz', '250Hz', '1kHz', '4kHz', '12kHz'] as const

export interface EqPreset {
  id: EqPresetId
  name: string
  bands: number[]
}

export const EQ_PRESETS: Record<EqPresetId, EqPreset> = {
  flat: { id: 'flat', name: '平坦', bands: [0, 0, 0, 0, 0] },
  pop: { id: 'pop', name: '流行', bands: [-1, 2, 4, 2, -1] },
  rock: { id: 'rock', name: '摇滚', bands: [4, 2, -1, 2, 3] },
  jazz: { id: 'jazz', name: '爵士', bands: [3, 1, 0, 2, 3] },
  vocal: { id: 'vocal', name: '人声', bands: [-2, -1, 4, 3, 1] },
  'bass-boost': { id: 'bass-boost', name: '低音增强', bands: [6, 4, 0, 0, 0] },
  custom: { id: 'custom', name: '自定义', bands: [0, 0, 0, 0, 0] },
}

// 用户可主动应用的预设：custom 仅作为状态指示，不在此处出现，
// 也不参与 detectPreset 的匹配。
export const EQ_APPLICABLE_PRESETS: EqPreset[] = [
  EQ_PRESETS.flat,
  EQ_PRESETS.pop,
  EQ_PRESETS.rock,
  EQ_PRESETS.jazz,
  EQ_PRESETS.vocal,
  EQ_PRESETS['bass-boost'],
]

// UI 渲染顺序：可应用预设在前，自定义状态指示在末尾。
export const EQ_PRESET_LIST: EqPreset[] = [...EQ_APPLICABLE_PRESETS, EQ_PRESETS.custom]

export function createDefaultEqualizer(): EqualizerSettings {
  return {
    enabled: false,
    preset: 'flat',
    bands: [...EQ_PRESETS.flat.bands],
  }
}

export function clampGain(value: number): number {
  if (Number.isNaN(value)) return 0
  if (!Number.isFinite(value)) return value > 0 ? EQ_MAX_GAIN : EQ_MIN_GAIN
  return Math.max(EQ_MIN_GAIN, Math.min(EQ_MAX_GAIN, value))
}

export function isValidPreset(id: unknown): id is EqPresetId {
  // 用 Object.hasOwn 而非 in:'toString' 等原型链属性在 in 下也返回 true,
  // 会把篡改 localStorage 写入的非法值误判为合法 preset。
  return typeof id === 'string' && Object.hasOwn(EQ_PRESETS, id)
}

export function normalizeBands(bands: unknown): number[] {
  if (!Array.isArray(bands)) return [...EQ_PRESETS.flat.bands]
  return EQ_BAND_FREQUENCIES.map((_, index) => {
    const raw = bands[index]
    return typeof raw === 'number' && Number.isFinite(raw) ? clampGain(raw) : 0
  })
}

export function sanitizeEqualizer(
  input: Partial<EqualizerSettings> | undefined,
): EqualizerSettings {
  const preset = isValidPreset(input?.preset) ? input!.preset : 'flat'
  const bands = normalizeBands(input?.bands)
  return {
    enabled: Boolean(input?.enabled),
    preset,
    bands,
  }
}

export function bandsMatchPreset(bands: number[], preset: EqPresetId): boolean {
  const target = EQ_PRESETS[preset].bands
  return bands.every((value, index) => value === target[index])
}

// 自动识别当前 bands 对应哪个可应用预设；没有匹配项时回落到 'custom'。
export function detectPreset(bands: number[]): EqPresetId {
  for (const preset of EQ_APPLICABLE_PRESETS) {
    if (bandsMatchPreset(bands, preset.id)) return preset.id
  }
  return 'custom'
}

export function bandFilterType(index: number): BiquadFilterType {
  if (index === 0) return 'lowshelf'
  if (index === EQ_BAND_COUNT - 1) return 'highshelf'
  return 'peaking'
}
