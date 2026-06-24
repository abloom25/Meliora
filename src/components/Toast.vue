<script setup lang="ts">
  defineProps<{
    message: string
    type?: 'success' | 'error' | 'info'
    position?: 'top' | 'bottom'
  }>()

  defineEmits<{ dismiss: [] }>()
</script>

<template>
  <Teleport to="body">
    <Transition name="toast-fade">
      <div
        v-if="message"
        class="app-toast"
        :class="[type || 'info', position || 'top']"
        @click="$emit('dismiss')"
      >
        {{ message }}
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped lang="scss">
  .app-toast {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    z-index: 100;
    max-width: min(520px, calc(100vw - 44px));
    padding: 10px 15px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 15px;
    corner-shape: squircle;
    backdrop-filter: blur(34px) saturate(150%);
    color: rgba(255, 255, 255, 0.86);
    font-size: 0.76rem;
    font-weight: 520;
    line-height: 1.35;
    text-align: center;
    cursor: pointer;
    box-shadow:
      0 14px 44px rgba(0, 0, 0, 0.22),
      inset 0 1px rgba(255, 255, 255, 0.08);
  }

  .app-toast.top {
    top: 68px;
  }

  .app-toast.bottom {
    bottom: 24px;
  }

  .app-toast.success {
    background: rgba(129, 216, 208, 0.2);
    color: #fff;
  }

  .app-toast.error {
    background: rgba(255, 139, 139, 0.18);
    color: #ffd0d0;
  }

  .app-toast.info {
    background: rgba(42, 42, 46, 0.46);
  }

  .toast-fade-enter-active,
  .toast-fade-leave-active {
    transition:
      opacity 0.3s cubic-bezier(0.22, 1, 0.36, 1),
      filter 0.3s ease,
      transform 0.34s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .toast-fade-enter-from,
  .toast-fade-leave-to {
    opacity: 0;
    filter: blur(10px);
    transform: translate(-50%, -10px) scale(0.98);
  }

  .toast-fade-enter-to,
  .toast-fade-leave-from {
    opacity: 1;
    filter: blur(0);
    transform: translateX(-50%) scale(1);
  }
</style>
