<script setup lang="ts">
  import { ref } from 'vue'
  import { Lock } from '@lucide/vue'
  import { useAdminAuth } from '../composables/useAdminAuth'
  import AdminAuthCard from '../components/AdminAuthCard.vue'

  const { login, authError } = useAdminAuth()
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
      errorMessage.value = authError.value || '登录失败,请重试'
      password.value = ''
    }
  }
</script>

<template>
  <AdminAuthCard
    title="登录管理后台"
    description="请输入管理员密码以继续"
    :loading="loading"
    :submit-disabled="loading || !password"
    submit-label="登录"
    submitting-label="登录中..."
    :error="errorMessage"
    @submit="submit"
  >
    <template #icon><Lock :size="28" /></template>
    <label class="sr-only" for="admin-password">管理员密码</label>
    <input
      id="admin-password"
      v-model="password"
      type="password"
      class="login-input"
      placeholder="密码"
      autocomplete="current-password"
      :disabled="loading"
      autofocus
    />
  </AdminAuthCard>
</template>

<style scoped lang="scss">
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
</style>
