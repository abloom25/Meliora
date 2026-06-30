<script setup lang="ts">
  import { onBeforeUnmount, onMounted, ref } from 'vue'
  import { GitFork, RefreshCw, ExternalLink, Check, AlertCircle, Loader2 } from '@lucide/vue'
  import { APP_VERSION } from '../../generated/app-version'
  import {
    checkUpdate,
    fetchUpdateStatus,
    triggerUpdate,
    type UpdateInfo,
    type UpdateStatusInfo,
  } from '../services/admin-api'
  import type { MusicConfig } from '../../types/music'
  import ConfirmModal from '../components/ConfirmModal.vue'

  const REPO_URL = 'https://github.com/abloom25/Meliora'
  const props = defineProps<{ config: MusicConfig }>()

  const projectDesc =
    '基于 Vue 3、TypeScript、Pinia 和 SCSS 的沉浸式单页音乐播放器。所有远程歌单和本地音乐会合并为一个匿名曲库,页面不会显示歌单名称、平台或来源。'

  type CheckState = 'idle' | 'checking' | 'latest' | 'available' | 'error'
  type UpdateRunState =
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
  const checkState = ref<CheckState>('idle')
  const updateRunState = ref<UpdateRunState>('idle')
  const updateInfo = ref<UpdateInfo | null>(null)
  const updateStatus = ref<UpdateStatusInfo | null>(null)
  const checkError = ref('')
  const showUpdateModal = ref(false)
  const updating = ref(false)
  const updateMessage = ref('')
  const triggeredAt = ref('')
  const triggerId = ref('')
  const statusErrorCount = ref(0)
  let checkController: AbortController | null = null
  let statusController: AbortController | null = null
  let statusTimer: number | null = null

  async function handleCheckUpdate(openModalOnUpdate = true) {
    if (checkState.value === 'checking') return
    checkController?.abort()
    checkController = new AbortController()
    checkState.value = 'checking'
    checkError.value = ''
    const controller = checkController
    const result = await checkUpdate(
      APP_VERSION,
      props.config.githubProxy,
      props.config.receivePrereleaseUpdates === true,
      controller.signal,
    )
    if (controller !== checkController) return
    checkController = null
    if (result.ok && result.data) {
      updateInfo.value = result.data
      checkState.value = result.data.hasUpdate ? 'available' : 'latest'
      if (result.data.hasUpdate && openModalOnUpdate) {
        showUpdateModal.value = true
      }
    } else {
      checkState.value = result.error === '检查已取消' ? 'idle' : 'error'
      checkError.value = result.error || '获取失败'
    }
  }

  async function handleUpdate() {
    if (updating.value) return
    updating.value = true
    updateRunState.value = 'triggering'
    updateMessage.value = ''
    clearStatusPolling()
    const result = await triggerUpdate(
      props.config.githubProxy,
      updateInfo.value?.targetTag || updateInfo.value?.latestVersion || '',
      props.config.receivePrereleaseUpdates === true,
    )
    updating.value = false
    if (result.ok) {
      showUpdateModal.value = false
      triggeredAt.value = result.triggeredAt || new Date().toISOString()
      triggerId.value = result.triggerId || ''
      updateRunState.value = 'locating'
      updateMessage.value = result.message || '已触发更新流程,正在等待执行状态'
      statusErrorCount.value = 0
      void pollUpdateStatus(0)
    } else {
      updateRunState.value = 'error'
      updateMessage.value = result.error || '触发失败'
    }
  }

  function getUpdateButtonText() {
    if (checkState.value === 'checking') return '检查中'
    if (checkState.value === 'latest') return '已是最新版'
    if (checkState.value === 'available') return '有新版本'
    if (checkState.value === 'error') return checkError.value || '获取失败'
    return '检查更新'
  }

  function getRunMessage() {
    if (updateRunState.value === 'triggering') return '正在触发更新流程...'
    if (updateRunState.value === 'locating')
      return '已触发更新,正在等待 GitHub Actions 创建运行记录...'
    if (updateRunState.value === 'queued') return '更新任务已排队,等待 GitHub Actions 执行'
    if (updateRunState.value === 'running')
      return '正在自动同步代码并执行验证,通过后会推送到当前分支'
    if (updateRunState.value === 'success')
      return '更新完成,已自动同步并推送到当前分支,稍后刷新查看新版本'
    if (updateRunState.value === 'failed') {
      return updateStatus.value?.failure?.message || '更新失败,目标分支未写入更新'
    }
    if (updateRunState.value === 'cancelled') return '更新任务已取消,目标分支未写入更新'
    if (updateRunState.value === 'timed_out') return '更新任务超时,目标分支未写入更新'
    if (updateRunState.value === 'error')
      return updateMessage.value || '无法获取更新状态,请稍后重试'
    return ''
  }

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

  async function pollUpdateStatus(delayMs = 0) {
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
    if (updateRunState.value === 'locating' || updateRunState.value === 'queued') {
      scheduleStatusPolling(3000)
    } else if (updateRunState.value === 'running') {
      scheduleStatusPolling(5000)
    }
  }

  onMounted(() => {
    void handleCheckUpdate(false)
  })

  onBeforeUnmount(() => {
    checkController?.abort()
    checkController = null
    clearStatusPolling()
  })
</script>

<template>
  <div class="about-page">
    <div class="about-hero">
      <div class="hero-icon">
        <img src="/favicon.svg" alt="Meliora" />
      </div>

      <h1 class="hero-title">Meliora</h1>
      <span class="hero-version">v{{ APP_VERSION }}</span>

      <p class="hero-desc">{{ projectDesc }}</p>

      <div class="hero-meta">
        <a class="meta-link" :href="REPO_URL" target="_blank" rel="noopener noreferrer">
          <GitFork :size="15" />
          <span>GitHub 仓库</span>
          <ExternalLink :size="12" class="external-icon" />
        </a>
        <button
          type="button"
          class="meta-update-btn"
          :class="checkState"
          :disabled="checkState === 'checking'"
          @click="handleCheckUpdate(true)"
        >
          <span>{{ getUpdateButtonText() }}</span>
          <Loader2 v-if="checkState === 'checking'" :size="15" class="spin" />
          <Check v-else-if="checkState === 'latest'" :size="15" />
          <AlertCircle
            v-else-if="checkState === 'available' || checkState === 'error'"
            :size="15"
          />
          <RefreshCw v-else :size="15" />
        </button>
      </div>

      <Transition name="fade">
        <div v-if="updateMessage" class="update-message">{{ updateMessage }}</div>
      </Transition>

      <Transition name="fade">
        <div v-if="updateRunState !== 'idle'" class="update-status" :class="updateRunState">
          <div class="status-main">
            <Loader2
              v-if="
                updateRunState === 'triggering' ||
                updateRunState === 'locating' ||
                updateRunState === 'queued' ||
                updateRunState === 'running'
              "
              :size="15"
              class="spin"
            />
            <Check v-else-if="updateRunState === 'success'" :size="15" />
            <AlertCircle v-else :size="15" />
            <span>{{ getRunMessage() }}</span>
          </div>
          <div v-if="updateStatus?.run?.htmlUrl" class="status-links">
            <a :href="updateStatus.run.htmlUrl" target="_blank" rel="noopener noreferrer">
              查看 GitHub Actions
              <ExternalLink :size="12" />
            </a>
            <a
              v-if="updateStatus.run.latestCommitUrl && updateRunState === 'success'"
              :href="updateStatus.run.latestCommitUrl"
              target="_blank"
              rel="noopener noreferrer"
            >
              查看更新提交
              <ExternalLink :size="12" />
            </a>
          </div>
        </div>
      </Transition>
    </div>

    <ConfirmModal
      :visible="showUpdateModal && !!updateInfo"
      cancel-text="关闭"
      :confirm-text="updating ? '更新中...' : '更新'"
      :loading="updating"
      width="min(440px, calc(100vw - 36px))"
      @cancel="showUpdateModal = false"
      @confirm="handleUpdate"
    >
      <template #header>
        <div class="modal-head">
          <h3>发现新版本</h3>
          <span class="version-badge">v{{ updateInfo?.latestVersion }}</span>
        </div>
      </template>
      <p class="modal-current">当前版本:v{{ updateInfo?.currentVersion }}</p>
      <div class="release-notes">
        <h4>更新内容</h4>
        <pre>{{ updateInfo?.releaseNotes || '暂无更新说明' }}</pre>
      </div>
    </ConfirmModal>
  </div>
</template>

<style scoped lang="scss">
  .about-page {
    min-height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
  }

  .about-hero {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    min-height: calc(100vh - 48px);
    padding: 56px 24px;
  }

  .hero-icon {
    width: 72px;
    height: 72px;
    border-radius: 20px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    margin-bottom: 18px;

    img {
      width: 44px;
      height: 44px;
    }
  }

  .hero-title {
    margin: 0;
    color: #fff;
    font-size: 1.8rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .hero-version {
    color: var(--text-subtle);
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
    margin-top: 4px;
  }

  .hero-desc {
    margin: 18px 0 22px;
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.86rem;
    line-height: 1.6;
    max-width: 480px;
  }

  .hero-meta {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 10px;
  }

  .meta-link,
  .meta-update-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 9px 16px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.85);
    font-size: 0.8rem;
    font-weight: 540;
    text-decoration: none;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.22);
    }
  }

  .meta-update-btn {
    border-radius: 11px;
    min-width: 104px;

    &.checking {
      opacity: 0.72;
      cursor: not-allowed;
    }

    &.latest {
      background: rgba(109, 213, 140, 0.14);
      border-color: rgba(109, 213, 140, 0.32);
      color: #6dd58c;
    }

    &.available {
      background: rgba(255, 192, 74, 0.14);
      border-color: rgba(255, 192, 74, 0.32);
      color: #ffc04a;
    }

    &.error {
      background: rgba(255, 99, 99, 0.16);
      border-color: rgba(255, 99, 99, 0.36);
      color: #ff8b8b;
    }

    &:disabled {
      cursor: not-allowed;
    }
  }

  .external-icon {
    opacity: 0.5;
  }

  .spin {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .update-message {
    margin-top: 18px;
    padding: 10px 14px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--accent), transparent 88%);
    border: 1px solid color-mix(in srgb, var(--accent), transparent 75%);
    color: var(--accent);
    font-size: 0.8rem;
  }

  .update-status {
    width: min(520px, 100%);
    margin-top: 14px;
    padding: 12px 14px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 14px;
    background: rgba(0, 0, 0, 0.24);
    color: rgba(255, 255, 255, 0.78);
    font-size: 0.78rem;
    text-align: left;

    &.success {
      border-color: rgba(109, 213, 140, 0.3);
      color: #7ee09a;
    }

    &.failed,
    &.cancelled,
    &.timed_out,
    &.error {
      border-color: rgba(255, 99, 99, 0.36);
      color: #ff9a9a;
    }
  }

  .status-main,
  .status-links a {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }

  .status-main {
    line-height: 1.5;
  }

  .status-links {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 10px;

    a {
      color: inherit;
      font-size: 0.74rem;
      text-decoration: none;
      opacity: 0.86;

      &:hover {
        opacity: 1;
        text-decoration: underline;
      }
    }
  }

  .modal-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;

    h3 {
      margin: 0;
      color: #fff;
      font-size: 1.05rem;
      font-weight: 680;
    }
  }

  .version-badge {
    padding: 3px 10px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--accent), transparent 82%);
    color: var(--accent);
    font-size: 0.74rem;
    font-weight: 680;
    font-variant-numeric: tabular-nums;
  }

  .modal-current {
    margin: 0 0 18px;
    color: var(--text-subtle);
    font-size: 0.8rem;
  }

  .release-notes {
    margin-bottom: 22px;

    h4 {
      margin: 0 0 8px;
      color: rgba(255, 255, 255, 0.7);
      font-size: 0.78rem;
      font-weight: 620;
    }

    pre {
      margin: 0;
      padding: 14px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.8);
      font-size: 0.78rem;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: inherit;
      max-height: 240px;
      overflow-y: auto;
    }
  }

  .fade-enter-active,
  .fade-leave-active {
    transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .fade-enter-from,
  .fade-leave-to {
    opacity: 0;
  }
</style>
