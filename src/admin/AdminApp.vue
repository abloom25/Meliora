<script setup lang="ts">
  import { onMounted } from 'vue'
  import { adminBuildEnv } from '../generated/admin-env'
  import { useAdminAuth } from './composables/useAdminAuth'
  import LoginView from './views/LoginView.vue'
  import DashboardView from './views/DashboardView.vue'
  import SetupView from './views/SetupView.vue'

  const {
    authenticated,
    checking,
    initialized,
    setupChecking,
    apiUnavailable,
    adminStatus,
    adminStatusDetail,
    checkSetupStatus,
    checkAuth,
  } = useAdminAuth()

  onMounted(async () => {
    if (adminBuildEnv.status !== 'idle') {
      adminStatus.value = adminBuildEnv.status
      adminStatusDetail.value = adminBuildEnv.detail
      initialized.value = true
      checking.value = false
      setupChecking.value = false
      return
    }
    await checkSetupStatus()
    if (adminStatus.value !== 'idle' || apiUnavailable.value) {
      checking.value = false
      return
    }
    if (initialized.value) {
      await checkAuth()
    } else {
      checking.value = false
    }
  })
</script>

<template>
  <div class="admin-shell">
    <div class="admin-body">
      <div v-if="adminStatus === 'disabled'" class="admin-notice">
        <h2>管理后台已禁用</h2>
        <p>部署者已通过环境变量关闭管理后台。如需启用,请移除 ADMIN_DISABLED 环境变量并重新部署。</p>
      </div>
      <div v-else-if="adminStatus === 'env-not-ready'" class="admin-notice">
        <h2>环境变量未就绪</h2>
        <p>
          {{
            adminStatusDetail ||
            '管理后台所需的必要环境变量缺失或无效,已锁定全部功能。请在部署平台配置所需变量后重新部署。'
          }}
        </p>
      </div>
      <div v-else-if="apiUnavailable" class="admin-notice">
        <h2>后端不可用</h2>
        <p>当前部署不支持管理后台。请使用 Cloudflare Pages、Vercel 或 Netlify 部署以启用此功能。</p>
      </div>
      <div v-else-if="setupChecking || checking" class="admin-notice">
        <p>正在验证...</p>
      </div>
      <Transition v-else name="admin-fade" mode="out-in">
        <SetupView v-if="!initialized" />
        <LoginView v-else-if="!authenticated" />
        <DashboardView v-else />
      </Transition>
    </div>
  </div>
</template>

<style scoped lang="scss">
  .admin-shell {
    height: 100svh;
    overflow: hidden;
    background: #0e0d12;
    color: rgba(255, 255, 255, 0.9);
    font-family: Inter, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    display: flex;
    flex-direction: column;
  }

  .admin-body {
    flex: 1;
    min-height: 0;
    display: flex;
    overflow: hidden;
  }

  .admin-notice {
    margin: auto;
    padding: 32px;
    text-align: center;
    max-width: 420px;

    h2 {
      margin: 0 0 10px;
      color: #fff;
      font-size: 1.05rem;
    }

    p {
      margin: 0;
      color: var(--text-subtle);
      font-size: 0.85rem;
      line-height: 1.6;
    }
  }

  .admin-fade-enter-active,
  .admin-fade-leave-active {
    transition: opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .admin-fade-enter-from,
  .admin-fade-leave-to {
    opacity: 0;
  }

  @media (max-width: 760px) {
    .admin-body {
      flex-direction: column;
      overflow: hidden;
    }

    .admin-notice {
      max-width: min(420px, calc(100vw - 32px));
      padding: 24px 16px;
    }
  }
</style>
