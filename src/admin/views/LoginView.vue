<script setup lang="ts">
  import { ref } from 'vue'
  import { Lock } from '@lucide/vue'
  import { useAdminAuth } from '../composables/useAdminAuth'

  const { login } = useAdminAuth()
  const password = ref('')
  const loading = ref(false)
  const errorMessage = ref('')

  async function submit() {
    if (!password.value || loading.value) return
    loading.value = true
    errorMessage.value = ''
    const success = await login(password.value)
    loading.value = false
    if (!success) {
      errorMessage.value = '密码错误,请重试'
      password.value = ''
    }
  }
</script>

<template>
  <form class="login-card" @submit.prevent="submit">
    <div class="login-icon">
      <Lock :size="28" />
    </div>
    <h2>登录管理后台</h2>
    <p>请输入管理员密码以继续</p>

    <input
      v-model="password"
      type="password"
      class="login-input"
      placeholder="密码"
      :disabled="loading"
      autofocus
    />

    <button type="submit" class="login-button" :disabled="loading || !password">
      {{ loading ? '登录中...' : '登录' }}
    </button>

    <p v-if="errorMessage" class="login-error">{{ errorMessage }}</p>
  </form>
</template>

<style scoped lang="scss">
  .login-card {
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

  .login-icon {
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

  p {
    margin: 0 0 6px;
    color: var(--text-subtle);
    font-size: 0.78rem;
  }

  .login-input {
    width: 100%;
    padding: 12px 14px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 14px;
    background: rgba(0, 0, 0, 0.25);
    color: #fff;
    font-size: 0.88rem;
    outline: none;
    transition: border-color 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:focus {
      border-color: var(--accent);
    }

    &:disabled {
      opacity: 0.5;
    }
  }

  .login-button {
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

  .login-error {
    margin: 0;
    color: #ff8b8b;
    font-size: 0.76rem;
  }
</style>
