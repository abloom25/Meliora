<script setup lang="ts">
  import { ref } from 'vue'
  import { changePassword } from '../services/admin-api'
  import BaseInput from '../../components/BaseInput.vue'
  import Toast from '../../components/Toast.vue'

  const currentPassword = ref('')
  const newPassword = ref('')
  const confirmPassword = ref('')
  const saving = ref(false)
  const message = ref('')
  const messageType = ref<'success' | 'error' | ''>('')

  function showMessage(text: string, type: 'success' | 'error') {
    message.value = text
    messageType.value = type
    window.setTimeout(() => {
      message.value = ''
      messageType.value = ''
    }, 3500)
  }

  function clearMessage() {
    message.value = ''
    messageType.value = ''
  }

  async function submit() {
    if (saving.value) return

    if (!currentPassword.value || !newPassword.value) {
      showMessage('请填写所有字段', 'error')
      return
    }

    if (newPassword.value !== confirmPassword.value) {
      showMessage('两次输入的新密码不一致', 'error')
      return
    }

    if (newPassword.value.length < 6) {
      showMessage('新密码至少 6 位', 'error')
      return
    }

    saving.value = true
    const result = await changePassword(currentPassword.value, newPassword.value)
    saving.value = false

    if (result.ok) {
      showMessage('密码修改成功', 'success')
      currentPassword.value = ''
      newPassword.value = ''
      confirmPassword.value = ''
    } else {
      showMessage(result.error || '修改失败', 'error')
    }
  }
</script>

<template>
  <div class="security-editor">
    <div class="admin-section">
      <h3 class="section-title">修改密码</h3>

      <div class="setting-row">
        <span class="row-label"><strong>当前密码</strong></span>
        <BaseInput
          v-model="currentPassword"
          type="password"
          placeholder="输入当前密码"
          autocomplete="current-password"
        />
      </div>

      <div class="setting-row">
        <span class="row-label"><strong>新密码</strong></span>
        <BaseInput
          v-model="newPassword"
          type="password"
          placeholder="至少 6 位"
          autocomplete="new-password"
        />
      </div>

      <div class="setting-row">
        <span class="row-label"><strong>确认新密码</strong></span>
        <BaseInput
          v-model="confirmPassword"
          type="password"
          placeholder="再次输入新密码"
          autocomplete="new-password"
        />
      </div>

      <div class="setting-row action-row">
        <span class="row-label"><small>密码以 PBKDF2 hash 存储在仓库 admin.json</small></span>
        <button type="button" class="save-button" :disabled="saving" @click="submit">
          {{ saving ? '保存中...' : '保存修改' }}
        </button>
      </div>
    </div>

    <Toast :message="message" :type="messageType || 'info'" @dismiss="clearMessage" />
  </div>
</template>

<style scoped lang="scss">
  .security-editor {
    display: flex;
    flex-direction: column;
    gap: 14px;
    position: relative;
  }

  .admin-section {
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.11);
    border-radius: 22px;
    background: rgba(255, 255, 255, 0.075);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.045);
    backdrop-filter: blur(22px);
  }

  .section-title {
    margin: 0;
    padding: 12px 14px 10px;
    color: rgba(255, 255, 255, 0.48);
    font-size: 0.62rem;
    font-weight: 680;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 15px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.075);
  }

  .row-label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex-shrink: 0;

    strong {
      color: #fff;
      font-size: 0.86rem;
      font-weight: 560;
    }

    small {
      color: var(--text-subtle);
      font-size: 0.7rem;
      line-height: 1.4;
    }
  }

  .action-row {
    justify-content: space-between;
  }

  .save-button {
    padding: 9px 18px;
    border: none;
    border-radius: 12px;
    background: var(--accent);
    color: #0e0d12;
    font-size: 0.82rem;
    font-weight: 680;
    cursor: pointer;
    flex-shrink: 0;
    transition: filter 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover:not(:disabled) {
      filter: brightness(1.1);
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }
</style>
