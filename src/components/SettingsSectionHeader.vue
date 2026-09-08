<script setup lang="ts">
  import { RotateCcw } from '@lucide/vue'
  import { onBeforeUnmount, ref } from 'vue'

  // 恢复默认不可撤销,做成两段式:第一次点击只进入确认态,再点一次才真的重置。
  // 超时没等到第二次点击就自动退回,避免按钮长期停在"待确认"的样子误导人
  const CONFIRM_TIMEOUT_MS = 4000

  withDefaults(defineProps<{ title: string; resettable?: boolean }>(), { resettable: false })

  const emit = defineEmits<{ reset: [] }>()

  const confirming = ref(false)
  let confirmTimer = 0

  function cancelConfirm() {
    window.clearTimeout(confirmTimer)
    confirmTimer = 0
    confirming.value = false
  }

  function handleClick() {
    if (confirming.value) {
      cancelConfirm()
      emit('reset')
      return
    }
    confirming.value = true
    window.clearTimeout(confirmTimer)
    confirmTimer = window.setTimeout(cancelConfirm, CONFIRM_TIMEOUT_MS)
  }

  onBeforeUnmount(cancelConfirm)
</script>

<template>
  <header class="settings-section-header">
    <h3 class="settings-section-title">{{ title }}</h3>
    <button
      v-if="resettable"
      class="section-reset"
      :class="{ confirming }"
      type="button"
      @click="handleClick"
    >
      <RotateCcw :size="13" />
      <span>{{ confirming ? '再次点击恢复' : '恢复默认' }}</span>
    </button>
  </header>
</template>

<style scoped lang="scss">
  .settings-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px 10px;
  }

  .settings-section-title {
    margin: 0;
    color: rgba(255, 255, 255, 0.48);
    font-size: 0.62rem;
    font-weight: 680;
    // 与按钮文字用同一个行高,居中对齐后两段文字才落在同一条基线上
    line-height: 1;
    letter-spacing: 0.08em;
  }

  // 恢复默认是低频动作,常态压到与分组标题同一层级,不与设置项抢注意力
  .section-reset {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 8px;
    // 内边距会把文字往里推 8px,负 margin 抵消掉,让它的右边缘与下方开关、数值同一列
    margin-right: -8px;
    border: 0;
    border-radius: 10px;
    corner-shape: squircle;
    background: transparent;
    color: rgba(255, 255, 255, 0.4);
    font: inherit;
    font-size: 0.62rem;
    font-weight: 560;
    line-height: 1;
    cursor: pointer;
    transition:
      background 0.18s ease,
      color 0.18s ease;
  }

  // 图标比文字高,不让它撑开行高,否则按钮文字会被顶离标题所在的那条线
  .section-reset svg {
    flex: 0 0 auto;
    align-self: center;
  }

  .section-reset:hover {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.78);
  }

  .section-reset:active {
    transform: scale(0.97);
  }

  // 待确认态必须一眼可辨,否则两段式确认只是多点一次而已
  .section-reset.confirming {
    background: rgba(255, 138, 128, 0.18);
    color: #ff9d94;
  }

  .section-reset.confirming:hover {
    background: rgba(255, 138, 128, 0.28);
    color: #ffb4ad;
  }

  @media (max-width: 720px) {
    .settings-section-header {
      padding: 11px 12px 8px;
    }

    .settings-section-title {
      font-size: 0.58rem;
    }
  }

  @media (max-width: 360px), (max-height: 700px) and (max-width: 720px) {
    .settings-section-header {
      padding: 9px 10px 7px;
    }
  }
</style>
