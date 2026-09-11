// 设置项落盘用的存储实例。默认是 Web 的 localStorage 包装,
// 桌面端在启动时调一次 setSettingsStore 换成自己的实现即可,
// 状态层(stores/player)只通过 settingsStore() 访问,不知道底下是什么。

import type { KeyValueStore } from '../core/platform/storage'
import { safeStorage } from './web/storage'

let current: KeyValueStore = safeStorage

export function settingsStore(): KeyValueStore {
  return current
}

/** 替换存储实现。传 null 恢复为 Web 的 localStorage */
export function setSettingsStore(store: KeyValueStore | null): void {
  current = store ?? safeStorage
}
