<script setup lang="ts">
  import { ref } from 'vue'
  import { KeyRound, Eye, EyeOff } from '@lucide/vue'
  import { useAdminAuth } from '../composables/useAdminAuth'
  import AdminAuthCard from '../components/AdminAuthCard.vue'
  import { AUTH_CONSTANTS } from '../../../shared/constants'

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
    if (password.value.length < AUTH_CONSTANTS.MIN_PASSWORD_LENGTH) {
      errorMessage.value = `密码至少 ${AUTH_CONSTANTS.MIN_PASSWORD_LENGTH} 位`
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
  <AdminAuthCard
    title="初始化管理后台"
    description="首次使用,请设置管理员密码。设置后可通过管理后台修改。"
    :loading="loading"
    :submit-disabled="loading || !password || !confirmPassword"
    submit-label="完成初始化"
    submitting-label="初始化中..."
    :error="errorMessage"
    @submit="submit"
  >
    <template #icon><KeyRound :size="28" /></template>
    <div class="input-group">
      <label class="sr-only" for="setup-password">设置管理员密码</label>
      <input
        id="setup-password"
        v-model="password"
        :type="showPassword ? 'text' : 'password'"
        class="setup-input"
        :placeholder="`设置密码(至少 ${AUTH_CONSTANTS.MIN_PASSWORD_LENGTH} 位)`"
        autocomplete="new-password"
        :disabled="loading"
        autofocus
      />
      <button
        type="button"
        class="toggle-visibility"
        :title="showPassword ? '隐藏密码' : '显示密码'"
        :aria-label="showPassword ? '隐藏密码' : '显示密码'"
        @click="showPassword = !showPassword"
      >
        <component :is="showPassword ? EyeOff : Eye" :size="16" />
      </button>
    </div>

    <label class="sr-only" for="setup-password-confirm">确认管理员密码</label>
    <input
      id="setup-password-confirm"
      v-model="confirmPassword"
      :type="showPassword ? 'text' : 'password'"
      class="setup-input"
      placeholder="确认密码"
      autocomplete="new-password"
      :disabled="loading"
    />
  </AdminAuthCard>
</template>

<style scoped lang="scss">
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
</style>
