import { readonly, ref } from 'vue'
import { fetchUpdateStatus, triggerUpdate, type UpdateStatusInfo } from '../services/admin-api'

export type UpdateRunState =
  | 'idle'
  | 'triggering'
  | 'locating'
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'error'

// 模块级单例:更新触发与轮询状态必须跨组件存活——
// Dashboard 切 tab 会卸载 AboutView,若状态挂在组件实例上,轮询会随卸载丢失。
// 因此这里的 timer / AbortController 刻意不在 onBeforeUnmount 中清理,
// 轮询到达终态(success / failed / cancelled / timed_out / error)后自然停止。
const updateRunState = ref<UpdateRunState>('idle')
const updateStatus = ref<UpdateStatusInfo | null>(null)
const updateMessage = ref('')
const triggeredAt = ref('')
const triggerId = ref('')
const statusErrorCount = ref(0)
let statusController: AbortController | null = null
let statusTimer: number | null = null

function clearStatusPolling() {
  if (statusTimer !== null) {
    window.clearTimeout(statusTimer)
    statusTimer = null
  }
  statusController?.abort()
  statusController = null
}

function scheduleStatusPolling(delayMs: number) {
  if (!triggeredAt.value) return
  statusTimer = window.setTimeout(() => {
    void pollUpdateStatus()
  }, delayMs)
}

function applyUpdateStatus(data: UpdateStatusInfo) {
  updateStatus.value = data
  if (!data.run) {
    updateRunState.value = 'locating'
    return
  }
  const status = data.run.displayStatus
  updateRunState.value = status === 'unknown' ? 'error' : status
  updateMessage.value = data.message
}

async function pollUpdateStatus(delayMs = 0): Promise<void> {
  if (!triggeredAt.value) return
  clearStatusPolling()
  if (delayMs > 0) {
    scheduleStatusPolling(delayMs)
    return
  }

  statusController = new AbortController()
  const controller = statusController
  const result = await fetchUpdateStatus(triggeredAt.value, triggerId.value, controller.signal)
  if (controller !== statusController) return
  statusController = null

  if (!result.ok || !result.data) {
    statusErrorCount.value += 1
    updateRunState.value = statusErrorCount.value >= 3 ? 'error' : updateRunState.value
    updateMessage.value = result.error || '无法获取更新状态'
    if (statusErrorCount.value < 3) scheduleStatusPolling(5000)
    return
  }

  statusErrorCount.value = 0
  applyUpdateStatus(result.data)
  const retryDelayMs =
    result.data.retryAfterSeconds && result.data.retryAfterSeconds > 0
      ? result.data.retryAfterSeconds * 1000
      : null
  if (updateRunState.value === 'locating' || updateRunState.value === 'queued') {
    scheduleStatusPolling(retryDelayMs ?? 3000)
  } else if (updateRunState.value === 'running') {
    scheduleStatusPolling(retryDelayMs ?? 5000)
  }
}

function isUpdatePending(): boolean {
  return (
    updateRunState.value === 'locating' ||
    updateRunState.value === 'queued' ||
    updateRunState.value === 'running'
  )
}

export function useUpdateStatus() {
  async function startUpdate(options: {
    githubProxy?: string
    targetTag?: string
    receivePrereleaseUpdates: boolean
  }): Promise<boolean> {
    updateRunState.value = 'triggering'
    updateMessage.value = ''
    clearStatusPolling()
    const result = await triggerUpdate(
      options.githubProxy,
      options.targetTag,
      options.receivePrereleaseUpdates,
    )
    if (!result.ok) {
      updateRunState.value = 'error'
      updateMessage.value = result.error || '触发失败'
      return false
    }
    triggeredAt.value = result.triggeredAt || new Date().toISOString()
    triggerId.value = result.triggerId || ''
    updateRunState.value = 'locating'
    updateMessage.value = result.message || '已触发更新流程,正在等待执行状态'
    statusErrorCount.value = 0
    void pollUpdateStatus(0)
    return true
  }

  // 组件重新挂载时调用:存在未完成的触发且轮询已停(如无活动 timer / 请求)则恢复轮询。
  function resumeUpdatePolling() {
    if (!triggeredAt.value || !isUpdatePending()) return
    if (statusTimer !== null || statusController !== null) return
    void pollUpdateStatus(0)
  }

  function resetUpdateStatus() {
    clearStatusPolling()
    updateRunState.value = 'idle'
    updateStatus.value = null
    updateMessage.value = ''
    triggeredAt.value = ''
    triggerId.value = ''
    statusErrorCount.value = 0
  }

  return {
    updateRunState: readonly(updateRunState),
    updateStatus: readonly(updateStatus),
    updateMessage: readonly(updateMessage),
    startUpdate,
    resumeUpdatePolling,
    pollUpdateStatus,
    resetUpdateStatus,
  }
}
