<script setup lang="ts">
  import { onMounted, ref } from 'vue'
  import { useAdminAuth } from './composables/useAdminAuth'
  import LoginView from './views/LoginView.vue'
  import DashboardView from './views/DashboardView.vue'
  import SetupView from './views/SetupView.vue'

  const { authenticated, checking, initialized, setupChecking, checkAuth } = useAdminAuth()
  const apiUnavailable = ref(false)

  onMounted(async () => {
    try {
      const response = await fetch('/api/setup-status', { credentials: 'include' })
      // 后端在禁用/环境未就绪时会直出 HTML 状态页(可能为 403),必须先于 !response.ok 判定,
      // 否则禁用页(403)会被提前拦截,用户看到的是误导性的"后端不可用"而非"已禁用"。
      const contentType = response.headers.get('Content-Type') || ''
      if (contentType.includes('text/html')) {
        document.open()
        document.write(await response.text())
        document.close()
        return
      }
      if (!response.ok) {
        apiUnavailable.value = true
        checking.value = false
        setupChecking.value = false
        return
      }
      const data = (await response.json().catch(() => ({}))) as { initialized?: boolean }
      initialized.value = Boolean(data.initialized)
      setupChecking.value = false
      if (initialized.value) {
        await checkAuth()
      } else {
        checking.value = false
      }
    } catch {
      apiUnavailable.value = true
      checking.value = false
      setupChecking.value = false
    }
  })
</script>

<template>
  <div class="admin-shell">
    <div class="admin-body">
      <div v-if="apiUnavailable" class="admin-notice">
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
</style>
