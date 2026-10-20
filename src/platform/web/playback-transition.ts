/**
 * 切歌分为准备与已提交两阶段。准备阶段阻止重入；提交后允许下一次切歌，
 * 但播放启动和淡入淡出的回调仍须检查任务身份。旧任务不能释放新任务的锁。
 */
export function createPlaybackTransition() {
  let current: AbortController | null = null
  let preparing = false

  function begin(): AbortController | null {
    if (preparing) return null
    current?.abort()
    current = new AbortController()
    preparing = true
    return current
  }

  function isCurrent(task: AbortController): boolean {
    return current === task && !task.signal.aborted
  }

  function release(task: AbortController | null = current) {
    if (task && isCurrent(task)) preparing = false
  }

  function cancel() {
    current?.abort()
    current = null
    preparing = false
  }

  return { begin, isCurrent, release, cancel, isPreparing: () => preparing }
}
