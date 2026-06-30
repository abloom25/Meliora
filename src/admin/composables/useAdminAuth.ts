import { ref } from 'vue'

const authenticated = ref(false)
const checking = ref(true)
const initialized = ref(false)
const setupChecking = ref(true)
const apiUnavailable = ref(false)
const adminStatus = ref<'idle' | 'disabled' | 'env-not-ready'>('idle')
const adminStatusDetail = ref('')

export function markAdminUnauthenticated(): void {
  authenticated.value = false
  checking.value = false
}

export function useAdminAuth() {
  async function checkSetupStatus(): Promise<void> {
    setupChecking.value = true
    apiUnavailable.value = false
    adminStatus.value = 'idle'
    adminStatusDetail.value = ''
    try {
      const response = await fetch('/api/setup-status', { credentials: 'include' })
      const contentType = response.headers.get('Content-Type') || ''
      if (!contentType.includes('application/json') || !response.ok) {
        apiUnavailable.value = true
        initialized.value = true
        return
      }

      const data = (await response.json().catch(() => ({}))) as {
        status?: string
        detail?: string
        initialized?: boolean
      }

      if (data.status === 'disabled') {
        adminStatus.value = 'disabled'
        adminStatusDetail.value = typeof data.detail === 'string' ? data.detail : ''
        initialized.value = true
        return
      }

      if (data.status === 'env-not-ready') {
        adminStatus.value = 'env-not-ready'
        adminStatusDetail.value = typeof data.detail === 'string' ? data.detail : ''
        initialized.value = true
        return
      }

      initialized.value = Boolean(data.initialized)
    } catch {
      apiUnavailable.value = true
      initialized.value = true
    } finally {
      setupChecking.value = false
    }
  }

  async function checkAuth(): Promise<void> {
    checking.value = true
    try {
      const response = await fetch('/api/auth', { credentials: 'include' })
      if (!response.ok) {
        markAdminUnauthenticated()
        return
      }
      const data = (await response.json()) as { authenticated?: boolean }
      authenticated.value = Boolean(data.authenticated)
    } catch {
      markAdminUnauthenticated()
    } finally {
      checking.value = false
    }
  }

  async function login(password: string): Promise<boolean> {
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!response.ok) {
        markAdminUnauthenticated()
        return false
      }
      authenticated.value = true
      return true
    } catch {
      markAdminUnauthenticated()
      return false
    }
  }

  async function setup(password: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await fetch('/api/setup', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        return { ok: false, error: data.error || '初始化失败' }
      }
      authenticated.value = true
      initialized.value = true
      return { ok: true }
    } catch {
      return { ok: false, error: '网络错误' }
    }
  }

  async function logout(): Promise<void> {
    try {
      await fetch('/api/logout', {
        method: 'POST',
        credentials: 'include',
      })
    } catch {
      // 即使请求失败也清除本地状态
    } finally {
      markAdminUnauthenticated()
    }
  }

  return {
    authenticated,
    checking,
    initialized,
    setupChecking,
    apiUnavailable,
    adminStatus,
    adminStatusDetail,
    checkSetupStatus,
    checkAuth,
    login,
    setup,
    logout,
  }
}
