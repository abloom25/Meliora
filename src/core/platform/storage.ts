// 键值存储的契约。核心层与状态层只认这个接口,不认 localStorage。
//
// 桌面端(Tauri)没有 localStorage,设置要落到配置文件或系统存储;Web 端由
// platform/web/storage.ts 用 localStorage 实现。两边只需满足这三个方法。
//
// 实现方必须**自己吞掉异常**:Safari 隐私模式、配额写满、权限受限都可能让读写抛错,
// 而这些失败不该冒泡到设置初始化流程里。

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 内存实现。没有可用存储时的兜底,也方便测试隔离 */
export function createMemoryStore(initial?: Readonly<Record<string, string>>): KeyValueStore {
  const map = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}
