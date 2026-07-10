<script setup lang="ts">
  defineProps<{
    title: string
    description: string
    loading: boolean
    submitDisabled: boolean
    submitLabel: string
    submittingLabel: string
    error?: string
  }>()

  defineEmits<{ submit: [] }>()
</script>

<template>
  <form class="auth-card" @submit.prevent="$emit('submit')">
    <div class="auth-icon"><slot name="icon" /></div>
    <h2>{{ title }}</h2>
    <p class="auth-description">{{ description }}</p>
    <slot />
    <button type="submit" class="auth-submit" :disabled="submitDisabled">
      {{ loading ? submittingLabel : submitLabel }}
    </button>
    <p v-if="error" class="auth-error" role="alert" aria-live="polite">{{ error }}</p>
  </form>
</template>

<style scoped lang="scss">
  .auth-card {
    width: 100%;
    max-width: 360px;
    margin: auto;
    padding: 36px 32px;
    background: rgba(255, 255, 255, 0.075);
    border: 1px solid rgba(255, 255, 255, 0.11);
    border-radius: 22px;
    backdrop-filter: blur(22px);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
  }

  .auth-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--accent), transparent 84%);
    color: var(--accent);
  }

  h2 {
    margin: 4px 0 0;
    color: #fff;
    font-size: 1.05rem;
    font-weight: 680;
  }

  .auth-description {
    margin: 0 0 6px;
    color: var(--text-subtle);
    font-size: 0.78rem;
    text-align: center;
    line-height: 1.5;
  }

  .auth-submit {
    width: 100%;
    padding: 12px 14px;
    border: none;
    border-radius: 14px;
    background: var(--accent);
    color: #0e0d12;
    font-size: 0.88rem;
    font-weight: 680;
    cursor: pointer;
    transition: filter 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover:not(:disabled) {
      filter: brightness(1.1);
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  .auth-error {
    margin: 0;
    color: #ff8b8b;
    font-size: 0.76rem;
    text-align: center;
  }

  @media (max-width: 480px) {
    .auth-card {
      max-width: calc(100vw - 32px);
      padding: 28px 22px;
    }
  }
</style>
