<script setup lang="ts">
  import {
    EQ_BAND_LABELS,
    EQ_PRESET_LIST,
    EQ_PRESETS,
    clampGain,
    detectPreset,
  } from '../utils/equalizer'
  import type { EqPresetId } from '../types/music'
  import { useHaptic } from '../composables/useHaptic'
  import SettingRange from './SettingRange.vue'
  import ToggleSwitch from './ToggleSwitch.vue'

  interface Props {
    enabled: boolean
    preset: EqPresetId
    bands: number[]
  }
  const props = defineProps<Props>()
  const emit = defineEmits<{
    'update:enabled': [value: boolean]
    'update:preset': [value: EqPresetId]
    'update:bands': [value: number[]]
  }>()

  const { triggerHaptic } = useHaptic()

  function selectPreset(preset: EqPresetId) {
    triggerHaptic('selection')
    if (preset === 'custom') {
      emit('update:preset', 'custom')
      return
    }
    emit('update:preset', preset)
    emit('update:bands', [...EQ_PRESETS[preset].bands])
  }

  function updateBand(index: number, value: number) {
    const bands = [...props.bands]
    bands[index] = clampGain(value)
    emit('update:bands', bands)
    emit('update:preset', detectPreset(bands))
  }
</script>

<template>
  <div class="settings-section">
    <h3 class="settings-section-title">音效</h3>
    <div class="setting-row toggle-row">
      <span><strong>均衡器</strong><small>调整各频段增益</small></span>
      <ToggleSwitch
        :model-value="enabled"
        aria-label="均衡器"
        @update:model-value="emit('update:enabled', $event)"
      />
    </div>
    <div class="setting-group eq-preset-group">
      <label
        ><span><strong>预设</strong></span></label
      >
      <div class="eq-preset-list">
        <button
          v-for="item in EQ_PRESET_LIST"
          :key="item.id"
          class="eq-preset-button"
          :class="{
            active: preset === item.id,
            'is-custom': item.id === 'custom',
          }"
          :disabled="!enabled"
          @click="selectPreset(item.id)"
        >
          {{ item.name }}
        </button>
      </div>
    </div>
    <div class="setting-group eq-bands">
      <label v-for="(label, index) in EQ_BAND_LABELS" :key="label" class="eq-band-row">
        <span class="eq-band-label">{{ label }}</span>
        <SettingRange
          class="eq-band-range"
          :model-value="bands[index] ?? 0"
          :min="-12"
          :max="12"
          :step="1"
          :disabled="!enabled"
          :aria-label="`${label} 增益`"
          :aria-value-text="`${(bands[index] ?? 0) > 0 ? '+' : ''}${bands[index] ?? 0}dB`"
          @update:model-value="updateBand(index, $event)"
        />
        <strong class="eq-band-value">
          {{ bands[index] > 0 ? '+' : '' }}{{ bands[index] }}dB
        </strong>
      </label>
    </div>
  </div>
</template>

<style scoped lang="scss">
  .settings-section {
    overflow: hidden;
    margin-top: 12px;
    border: 1px solid rgba(255, 255, 255, 0.11);
    border-radius: 22px;
    corner-shape: squircle;
    background: rgba(255, 255, 255, 0.075);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.045);
    backdrop-filter: blur(22px);
  }
  .settings-section-title {
    margin: 0;
    padding: 12px 14px 10px;
    color: rgba(255, 255, 255, 0.48);
    font-size: 0.62rem;
    font-weight: 680;
    letter-spacing: 0.08em;
  }
  .setting-group,
  .setting-row {
    padding: 15px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.075);
  }
  .settings-section > :first-child {
    border-top: 0;
  }
  .setting-group label,
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
  }
  .setting-group label > span,
  .setting-row > span {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .setting-group label > span {
    flex-direction: row;
    align-items: center;
    gap: 7px;
  }
  .setting-group strong,
  .setting-row strong {
    color: #fff;
    font-size: 0.8rem;
    font-weight: 560;
  }
  .setting-row small {
    color: var(--text-subtle);
    font-size: 0.66rem;
  }
  .eq-preset-group {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .eq-preset-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .eq-preset-button {
    padding: 7px 12px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 12px;
    corner-shape: squircle;
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.74);
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 560;
    cursor: pointer;
    transition:
      color 0.18s ease,
      background 0.18s ease,
      border-color 0.18s ease,
      opacity 0.18s ease;
  }
  .eq-preset-button:hover:not(:disabled) {
    color: #fff;
    background: rgba(255, 255, 255, 0.1);
  }
  .eq-preset-button.active {
    color: rgba(255, 255, 255, 0.96);
    background: rgba(var(--accent-rgb), 0.16);
    border-color: rgba(var(--accent-rgb), 0.32);
  }
  .eq-preset-button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .eq-preset-button.active:disabled {
    color: rgba(255, 255, 255, 0.74);
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.14);
  }
  .eq-preset-button.is-custom {
    font-style: italic;
  }
  .eq-bands {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
    margin-top: 12px;
  }
  .eq-band-row {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;
    padding: 5px 0;
    border-top: 0;
  }
  .eq-band-label {
    flex: 0 0 auto;
    width: 52px;
    color: #fff;
    font-size: 0.8rem;
    font-weight: 560;
    font-variant-numeric: tabular-nums;
  }
  .eq-band-range {
    flex: 1 1 auto;
    margin-top: 0;
  }
  .eq-band-value {
    flex: 0 0 auto;
    width: 52px;
    color: #fff;
    font-size: 0.8rem;
    font-weight: 560;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
</style>
