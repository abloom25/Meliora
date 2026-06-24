import { ref } from 'vue'

const authenticated = ref(false)
const checking = ref(true)
const initialized = ref(false)
const setupChecking = ref(true)

export function useAdminAuth() {
  async function checkSetupStatus(): Promise<void> {
    setupChecking.value = true
    try {
      const response = await fetch('/api/setup-status', { credentials: 'include' })
      // HTML 状态页(禁用/环境未就绪,可能为 403)需先于 !response.ok 判定并整页替换。
      const contentType = response.headers.get('Content-Type') || ''
      if (contentType.includes('text/html')) {
        document.open()
        document.write(await response.text())
        document.close()
        return
      }
      if (!response.ok) {
        initialized.value = true
        return
      }
      const data = (await response.json().catch(() => ({}))) as { initialized?: boolean }
      initialized.value = Boolean(data.initialized)
    } catch {
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
        authenticated.value = false
        return
      }
      const data = (await response.json()) as { authenticated?: boolean }
      authenticated.value = Boolean(data.authenticated)
    } catch {
      authenticated.value = false
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
        authenticated.value = false
        return false
      }
      authenticated.value = true
      return true
    } catch {
      authenticated.value = false
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
      authenticated.value = false
    }
  }

  return {
    authenticated,
    checking,
    initialized,
    setupChecking,
    checkSetupStatus,
    checkAuth,
    login,
    setup,
    logout,
  }
}
