import { watch, type Ref } from 'vue'
import type { PlayerSettings } from '../types/music'
import { EQ_PRESETS } from '../utils/equalizer'

export interface UseEqualizerOptions {
  settings: Ref<PlayerSettings>
}

export function useEqualizer(options: UseEqualizerOptions) {
  const { settings } = options
  let filters: BiquadFilterNode[] = []

  function applyGains() {
    if (!filters.length) return
    const eq = settings.value.equalizer
    const gains = eq.enabled ? eq.bands : EQ_PRESETS.flat.bands
    filters.forEach((filter, index) => {
      filter.gain.value = gains[index] ?? 0
    })
  }

  function bindFilters(nodes: BiquadFilterNode[]) {
    filters = nodes
    applyGains()
  }

  watch(() => settings.value.equalizer, applyGains, { deep: true })

  return { bindFilters, applyGains }
}
