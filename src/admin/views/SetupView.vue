<script setup lang="ts">
  import { ref } from 'vue'
  import { KeyRound, Eye, EyeOff } from '@lucide/vue'
  import { useAdminAuth } from '../composables/useAdminAuth'

  const { setup } = useAdminAuth()
  const password = ref('')
  const confirmPassword = ref('')
  const loading = ref(false)
  const errorMessage = ref('')
  const showPassword = ref(false)

  async function submit() {
    if (loading.value) return
    if (!password.value) {
      errorMessage.value = '请输入密码'
      return
    }
    if (password.value.length < 8) {
      errorMessage.value = '密码至少 8 位'
      return
    }
    if (password.value !== confirmPassword.value) {
      errorMessage.value = '两次输入的密码不一致'
      return
    }
    loading.value = true
    errorMessage.value = ''
    const result = await setup(password.value)
    loading.value = false
    if (!result.ok) {
      errorMessage.value = result.error || '初始化失败'
      password.value = ''
      confirmPassword.value = ''
    }
  }
</script>

<template>
  <form class="setup-card" @submit.prevent="submit">
    <div class="setup-icon">
      <KeyRound :size="28" />
    </div>
    <h2>初始化管理后台</h2>
    <p>首次使用,请设置管理员密码。设置后可通过管理后台修改。</p>

    <div class="input-group">
      <input
        v-model="password"
        :type="showPassword ? 'text' : 'password'"
        class="setup-input"
        placeholder="设置密码(至少 8 位)"
        :disabled="loading"
        autofocus
      />
      <button
        type="button"
        class="toggle-visibility"
        :title="showPassword ? '隐藏密码' : '显示密码'"
        @click="showPassword = !showPassword"
      >
        <component :is="showPassword ? EyeOff : Eye" :size="16" />
      </button>
    </div>

    <input
      v-model="confirmPassword"
      :type="showPassword ? 'text' : 'password'"
      class="setup-input"
      placeholder="确认密码"
      :disabled="loading"
    />

    <button type="submit" class="setup-button" :disabled="loading || !password || !confirmPassword">
      {{ loading ? '初始化中...' : '完成初始化' }}
    </button>

    <p v-if="errorMessage" class="setup-error">{{ errorMessage }}</p>
  </form>
</template>

<style scoped lang="scss">
  .setup-card {
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

  .setup-icon {
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
    text-align: center;
    line-height: 1.5;
  }

  .input-group {
    position: relative;
    width: 100%;
    display: flex;
  }

  .setup-input {
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

  .input-group .setup-input {
    padding-right: 42px;
  }

  .toggle-visibility {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--text-subtle);
    cursor: pointer;
    transition: color 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      color: rgba(255, 255, 255, 0.8);
    }
  }

  .setup-button {
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

  .setup-error {
    margin: 0;
    color: #ff8b8b;
    font-size: 0.76rem;
  }
</style>
