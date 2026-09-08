<script setup lang="ts">
  import { useId } from 'vue'
  import SettingRange from './SettingRange.vue'

  // 设置面板里「标题 + 当前值 + 滑块」这一组结构原来在 SettingsPanel 里重复了七遍,
  // 只有文案、单位与取值范围不同。抽出来后面板只描述"有哪些设置",不再描述"怎么摆"。

  withDefaults(
    defineProps<{
      modelValue: number
      /** 左侧标题 */
      label: string
      /** 右侧当前值,同时作为 aria-valuetext */
      valueText: string
      min: number
      max: number
      step?: number
      /** 标题下的灰字说明,给了就切换成竖排布局 */
      description?: string
    }>(),
    { step: 1, description: undefined },
  )

  defineEmits<{ 'update:modelValue': [value: number] }>()

  // 说明文字要一起念给读屏,所以仍走 aria-labelledby 指向整块标题,而不是 aria-label
  const labelId = useId()
</script>

<template>
  <div class="setting-group">
    <div class="setting-group-label" :class="{ stacked: Boolean(description) }">
      <span :id="labelId">
        <slot name="icon" />
        <strong>{{ label }}</strong>
        <small v-if="description">{{ description }}</small>
      </span>
      <strong>{{ valueText }}</strong>
    </div>
    <SettingRange
      :model-value="modelValue"
      :aria-labelledby="labelId"
      :aria-value-text="valueText"
      :min="min"
      :max="max"
      :step="step"
      @update:model-value="$emit('update:modelValue', $event)"
    />
  </div>
</template>

<style scoped lang="scss">
  // 外框的 padding 与分隔线由所在分组提供(SettingsPanel 的 .setting-group),
  // 这里只负责组内的排版
  .setting-group-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
  }

  .setting-group-label > span {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 7px;
  }

  // 带说明的滑块:标题与灰字竖排,间距与开关行一致
  .setting-group-label.stacked > span {
    flex-direction: column;
    align-items: flex-start;
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
    .setting-group-label {
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
