<script setup lang="ts">
  import { computed } from 'vue'
  import ToggleSwitch from '../../components/ToggleSwitch.vue'
  import type { PublicMusicConfig } from '../../../shared/music-config'
  import {
    MUSIC_SOURCE_KINDS,
    isMusicSourceEnabled,
    musicSourceEntries,
    withMusicSourceEnabled,
  } from '../../../shared/music-sources'

  const props = defineProps<{ config: PublicMusicConfig }>()
  const emit = defineEmits<{ 'update:config': [config: PublicMusicConfig] }>()

  // 开关列表直接由注册表生成:新增音源只要在 shared/music-sources.ts 补一项声明,
  // 这里自动多出一行,不需要改后台界面
  const sources = computed(() =>
    MUSIC_SOURCE_KINDS.map((kind) => ({
      ...kind,
      enabled: isMusicSourceEnabled(props.config, kind.id),
      count: musicSourceEntries(props.config, kind).length,
    })),
  )

  function setEnabled(id: string, enabled: boolean) {
    emit('update:config', withMusicSourceEnabled(props.config, id, enabled))
  }
</script>

<template>
  <div class="admin-section">
    <h3 class="section-title">音乐源</h3>
    <p class="section-hint">关掉的音源不会被加载,已配置的条目会保留</p>

    <div v-for="source in sources" :key="source.id" class="setting-row">
      <span class="row-label">
        <strong>{{ source.label }}</strong>
        <small>{{ source.description }}</small>
        <small class="row-count">
          已配置 {{ source.count }} {{ source.unit }}
          <template v-if="!source.enabled"> · 当前未启用</template>
        </small>
      </span>
      <ToggleSwitch
        :model-value="source.enabled"
        :aria-label="`启用${source.label}`"
        @update:model-value="setEnabled(source.id, $event)"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
  .admin-section {
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.11);
    border-radius: 22px;
    background: rgba(255, 255, 255, 0.075);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.045);
    backdrop-filter: blur(22px);
  }

  .section-title {
    margin: 0;
    padding: 12px 14px 10px;
    color: rgba(255, 255, 255, 0.48);
    font-size: 0.62rem;
    font-weight: 680;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .section-hint {
    margin: 0;
    padding: 0 14px 12px;
    color: rgba(255, 255, 255, 0.42);
    font-size: 0.72rem;
    line-height: 1.5;
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 15px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.075);
  }

  .row-label {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 3px;

    strong {
      color: rgba(255, 255, 255, 0.9);
      font-size: 0.82rem;
      font-weight: 660;
    }

    small {
      color: rgba(255, 255, 255, 0.5);
      font-size: 0.72rem;
      line-height: 1.45;
    }
  }

  .row-count {
    color: rgba(255, 255, 255, 0.38) !important;
    font-variant-numeric: tabular-nums;
  }
</style>
