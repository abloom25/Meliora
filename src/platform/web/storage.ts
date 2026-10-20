import type { KeyValueStore } from '../../core/platform/storage'

// 安全的 localStorage 包装：所有读写均 try/catch，避免 Safari Private 模式 / quota 满 / SSR 等场景下抛异常
function getStorage(): Storage | null {
  // 先用 typeof 判断，兼容 SSR 与 jsdom 等无 window 的边界场景
  if (typeof window === 'undefined') return null
  try {
    // 某些浏览器在禁用存储时访问 localStorage 属性本身就会抛异常
    return window.localStorage ?? null
  } catch {
    return null
  }
}

/** localStorage 实现的 KeyValueStore。所有读写 try/catch,失败静默 */
export const safeStorage: KeyValueStore = {
  getItem(key: string): string | null {
    const storage = getStorage()
    if (!storage) return null
    try {
      return storage.getItem(key)
    } catch {
      // Safari Private 模式或权限受限时静默失败，避免影响调用方初始化
      return null
    }
  },
  setItem(key: string, value: string): void {
    const storage = getStorage()
    if (!storage) return
    try {
      storage.setItem(key, value)
    } catch {
      // quota 已满或被禁用时静默忽略，保持调用方流程不被中断
    }
  },
  removeItem(key: string): void {
    const storage = getStorage()
    if (!storage) return
    try {
      storage.removeItem(key)
    } catch {
      // 任何异常都静默处理，确保 store 操作不会因存储失败而崩溃
    }
  },
}
