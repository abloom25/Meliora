<script setup lang="ts">
  import ToggleSwitch from './ToggleSwitch.vue'

  // 设置面板里「标题 + 说明 + 开关」这一行原来在 SettingsPanel 里重复了十余遍。
  // 顺带把整行做成可点:移动端点一行比精准点到 42px 宽的开关上要省事得多。

  const props = withDefaults(
    defineProps<{
      modelValue: boolean
      label: string
      description?: string
    }>(),
    { description: undefined },
  )

  const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

  function handleRowClick(event: MouseEvent) {
    // 点在开关本体上时 ToggleSwitch 已经处理过一次,冒泡到这里再取反会互相抵消
    if ((event.target as HTMLElement | null)?.closest('.toggle-switch')) return
    emit('update:modelValue', !props.modelValue)
  }
</script>

<template>
  <div class="setting-row toggle-row" @click="handleRowClick">
    <span>
      <strong>{{ label }}</strong>
      <small v-if="description">{{ description }}</small>
    </span>
    <ToggleSwitch
      :model-value="modelValue"
      :aria-label="label"
      @update:model-value="emit('update:modelValue', $event)"
    />
  </div>
</template>

<style scoped lang="scss">
  // 外框的 padding 与分隔线由所在分组提供(SettingsPanel 的 .setting-row)
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    cursor: pointer;
  }

  .setting-row > span {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  strong {
    color: #fff;
    font-size: 0.8rem;
    font-weight: 560;
  }

  small {
    color: var(--text-subtle);
    font-size: 0.66rem;
  }

  @media (max-width: 720px) {
    .setting-row {
      gap: 14px;
    }

    strong {
      font-size: 0.76rem;
    }

    small {
      font-size: 0.62rem;
      line-height: 1.35;
    }
  }
</style>
