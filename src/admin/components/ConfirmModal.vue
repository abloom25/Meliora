<script setup lang="ts">
  defineProps<{
    visible: boolean
    title?: string
    cancelText?: string
    confirmText?: string
    danger?: boolean
    loading?: boolean
    width?: string
  }>()

  const emit = defineEmits<{ cancel: []; confirm: [] }>()
</script>

<template>
  <Teleport to="body">
    <Transition name="confirm-modal">
      <div v-if="visible" class="confirm-modal-backdrop" @click.self="emit('cancel')">
        <div
          class="confirm-modal-card"
          :style="width ? { '--confirm-modal-width': width } : undefined"
        >
          <slot name="header">
            <h3 v-if="title">{{ title }}</h3>
          </slot>
          <div class="confirm-modal-body">
            <slot />
          </div>
          <div class="confirm-modal-actions">
            <button
              type="button"
              class="confirm-modal-btn cancel"
              :disabled="loading"
              @click="emit('cancel')"
            >
              {{ cancelText ?? '取消' }}
            </button>
            <button
              type="button"
              class="confirm-modal-btn confirm"
              :class="{ danger }"
              :disabled="loading"
              @click="emit('confirm')"
            >
              {{ confirmText ?? '确认' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped lang="scss">
  .confirm-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(8px);
  }

  .confirm-modal-card {
    width: var(--confirm-modal-width, min(380px, calc(100vw - 36px)));
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    padding: 24px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 22px;
    background: rgba(20, 19, 26, 0.95);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);

    h3 {
      margin: 0 0 8px;
      color: #fff;
      font-size: 1rem;
      font-weight: 680;
    }
  }

  .confirm-modal-body {
    margin: 0 0 20px;
    color: var(--text-subtle);
    font-size: 0.82rem;
    line-height: 1.5;

    :deep(p) {
      margin: 0;
    }

    :deep(strong) {
      color: rgba(255, 255, 255, 0.86);
      font-weight: 560;
    }
  }

  .confirm-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }

  .confirm-modal-btn {
    padding: 9px 18px;
    border-radius: 12px;
    font-size: 0.82rem;
    cursor: pointer;
    transition:
      background 0.2s cubic-bezier(0.16, 1, 0.3, 1),
      filter 0.2s cubic-bezier(0.16, 1, 0.3, 1),
      opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
  }

  .confirm-modal-btn.cancel {
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: transparent;
    color: rgba(255, 255, 255, 0.7);

    &:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.06);
    }
  }

  .confirm-modal-btn.confirm {
    border: none;
    background: var(--accent);
    color: #0e0d12;
    font-weight: 680;

    &:hover:not(:disabled) {
      filter: brightness(1.1);
    }

    &.danger {
      background: rgba(255, 99, 99, 0.85);
      color: #fff;
    }
  }

  .confirm-modal-enter-active,
  .confirm-modal-leave-active {
    transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    .confirm-modal-card {
      transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
  }

  .confirm-modal-enter-from,
  .confirm-modal-leave-to {
    opacity: 0;

    .confirm-modal-card {
      transform: scale(0.95);
    }
  }
</style>
