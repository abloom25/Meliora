<script setup lang="ts">
  import { Loader2, Undo2 } from '@lucide/vue'
  import { computed, onMounted, ref } from 'vue'
  import { useRouter } from 'vue-router'
  import { useAdminAuth } from '../composables/useAdminAuth'
  import { fetchConfig, saveConfig, type StagedUpload } from '../services/admin-api'
  import type { MusicConfig } from '../../types/music'
  import { collectManagedAssetPaths } from '../../../shared/managed-assets'
  import AdminSidebar from '../components/AdminSidebar.vue'
  import ConfirmModal from '../components/ConfirmModal.vue'
  import Toast from '../../components/Toast.vue'
  import SiteSettingsEditor from '../components/SiteSettingsEditor.vue'
  import PlaylistEditor from '../components/PlaylistEditor.vue'
  import LocalTrackEditor from '../components/LocalTrackEditor.vue'
  import AnalyticsSettingsEditor from '../components/AnalyticsSettingsEditor.vue'
  import AdvancedSettingsEditor from '../components/AdvancedSettingsEditor.vue'
  import SecurityEditor from '../components/SecurityEditor.vue'
  import ConfigTransferView from './ConfigTransferView.vue'
  import AboutView from './AboutView.vue'
  import { useTimedMessage } from '../composables/useTimedMessage'
  import { useFileStagingState } from '../composables/useFileStagingState'

  const router = useRouter()
  const { logout } = useAdminAuth()
  const config = ref<MusicConfig | null>(null)
  const savedConfig = ref<MusicConfig | null>(null)
  const loading = ref(true)
  const saving = ref(false)
  const activeTab = ref('site')
  const { message, messageType, showMessage, clearMessage } = useTimedMessage()
  const showSaveConfirm = ref(false)
  const showExitConfirm = ref(false)
  const showRevertConfirm = ref(false)
  const pendingExitAction = ref<'logout' | 'back' | null>(null)
  const stagedUploads = ref<StagedUpload[]>([])
  const { activeFileStageCount } = useFileStagingState()

  const hasConfig = computed(() => config.value !== null)
  const referencedStagedUploads = computed(() => {
    if (!config.value) return []
    const referencedPaths = collectManagedAssetPaths(config.value)
    return stagedUploads.value.filter((upload) => referencedPaths.has(upload.path))
  })
  const hasUnsavedChanges = computed(() => {
    if (!config.value || !savedConfig.value) return false
    if (referencedStagedUploads.value.length > 0) return true
    return (
      stableStringify(normalizeConfig(config.value)) !==
      stableStringify(normalizeConfig(savedConfig.value))
    )
  })
  const pendingDeletionPaths = computed(() => {
    if (!config.value || !savedConfig.value) return []
    const nextPaths = collectManagedAssetPaths(config.value)
    return [...collectManagedAssetPaths(savedConfig.value)].filter((path) => !nextPaths.has(path))
  })
  const hasPendingWork = computed(() => hasUnsavedChanges.value || activeFileStageCount.value > 0)

  function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableStringify(item)).join(',')}]`
    }

    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
        .join(',')}}`
    }

    return JSON.stringify(value)
  }

  function normalizeConfig(source: MusicConfig): MusicConfig {
    const next = JSON.parse(JSON.stringify(source)) as MusicConfig
    normalizeOptionalText(next, 'apiToken')
    normalizeOptionalText(next, 'githubProxy')
    normalizeOptionalText(next, 'googleSiteVerification')
    normalizeOptionalText(next, 'customCss')
    normalizeOptionalText(next, 'customJs')

    if (next.umami) {
      normalizeOptionalText(next.umami, 'scriptUrl')
      normalizeOptionalText(next.umami, 'websiteId')
      if (!next.umami.enabled && !next.umami.scriptUrl && !next.umami.websiteId) {
        delete next.umami
      }
    }

    if (next.googleAnalytics) {
      normalizeOptionalText(next.googleAnalytics, 'measurementId')
      if (!next.googleAnalytics.enabled && !next.googleAnalytics.measurementId) {
        delete next.googleAnalytics
      }
    }

    return next
  }

  function normalizeOptionalText<T extends object>(target: T, key: keyof T) {
    const record = target as Record<string, unknown>
    if (typeof record[key as string] === 'string' && !String(record[key as string]).trim()) {
      delete record[key as string]
    }
  }

  onMounted(async () => {
    loading.value = true
    const loaded = await fetchConfig()
    if (loaded) {
      config.value = loaded
      savedConfig.value = JSON.parse(JSON.stringify(loaded))
    } else {
      showMessage('配置加载失败', 'error')
    }
    loading.value = false
  })

  function requestSave() {
    if (!config.value || saving.value) return
    if (activeFileStageCount.value > 0) {
      showMessage(`还有 ${activeFileStageCount.value} 个文件正在暂存，请稍候`, 'error')
      return
    }
    showSaveConfirm.value = true
  }

  function requestRevert() {
    if (!hasUnsavedChanges.value) return
    showRevertConfirm.value = true
  }

  function confirmRevert() {
    if (savedConfig.value) {
      config.value = JSON.parse(JSON.stringify(savedConfig.value))
    }
    stagedUploads.value = []
    showRevertConfirm.value = false
  }

  function handleFileStaged(upload: StagedUpload) {
    stagedUploads.value = [
      ...stagedUploads.value.filter((item) => item.path !== upload.path),
      upload,
    ]
  }

  async function confirmSave() {
    if (!config.value || saving.value) return
    if (activeFileStageCount.value > 0) {
      showSaveConfirm.value = false
      showMessage(`还有 ${activeFileStageCount.value} 个文件正在暂存，请稍候`, 'error')
      return
    }
    showSaveConfirm.value = false
    saving.value = true
    const result = await saveConfig(config.value, referencedStagedUploads.value)
    saving.value = false
    if (result.ok) {
      savedConfig.value = JSON.parse(JSON.stringify(config.value))
      stagedUploads.value = []
      showMessage('保存成功，配置和文件已提交，正在等待网站更新', 'success')
    } else {
      showMessage(result.error || '保存失败', 'error')
    }
  }

  function handleLogout() {
    if (hasPendingWork.value) {
      pendingExitAction.value = 'logout'
      showExitConfirm.value = true
    } else {
      void doLogout()
    }
  }

  function handleBack() {
    if (hasPendingWork.value) {
      pendingExitAction.value = 'back'
      showExitConfirm.value = true
    } else {
      void doBack()
    }
  }

  async function doLogout() {
    showExitConfirm.value = false
    pendingExitAction.value = null
    await logout()
  }

  function doBack() {
    showExitConfirm.value = false
    pendingExitAction.value = null
    void router.push('/')
  }

  function confirmExit() {
    if (pendingExitAction.value === 'logout') {
      void doLogout()
    } else if (pendingExitAction.value === 'back') {
      doBack()
    }
  }
</script>

<template>
  <div class="dashboard-shell">
    <AdminSidebar
      :active="activeTab"
      :config="config"
      :saving="saving"
      :save-disabled="activeFileStageCount > 0"
      @update:active="activeTab = $event"
      @save="requestSave"
      @logout="handleLogout"
      @back="handleBack"
    />

    <main class="dashboard-content">
      <div v-if="loading" class="content-loading">加载配置中...</div>

      <template v-else-if="hasConfig && config">
        <Transition name="tab-fade" mode="out-in">
          <SiteSettingsEditor
            v-if="activeTab === 'site'"
            key="site"
            :config="config"
            @update:config="config = $event"
            @file-staged="handleFileStaged"
            @notify="(message: string, type: 'success' | 'error') => showMessage(message, type)"
          />
          <div v-else-if="activeTab === 'playlists'" key="playlists" class="tab-wrapper">
            <div class="admin-section">
              <h3 class="section-title">远程歌单</h3>
              <PlaylistEditor
                :playlists="config.playlists"
                @update:playlists="config = { ...config, playlists: $event }"
              />
            </div>
          </div>
          <div v-else-if="activeTab === 'local'" key="local" class="tab-wrapper">
            <div class="admin-section">
              <h3 class="section-title">本地音乐</h3>
              <LocalTrackEditor
                :tracks="config.localTracks"
                @update:tracks="config = { ...config, localTracks: $event }"
                @file-staged="handleFileStaged"
              />
            </div>
          </div>
          <AnalyticsSettingsEditor
            v-else-if="activeTab === 'analytics'"
            key="analytics"
            :config="config"
            @update:config="config = $event"
          />
          <AdvancedSettingsEditor
            v-else-if="activeTab === 'advanced'"
            key="advanced"
            :config="config"
            @update:config="config = $event"
          />
          <SecurityEditor v-else-if="activeTab === 'security'" key="security" />
          <ConfigTransferView
            v-else-if="activeTab === 'transfer'"
            key="transfer"
            :config="config"
            @update:config="config = $event"
            @notify="(message: string, type: 'success' | 'error') => showMessage(message, type)"
          />
          <AboutView v-else-if="activeTab === 'about'" key="about" :config="config" />
        </Transition>
      </template>

      <div v-else class="content-loading">配置加载失败,请刷新重试</div>

      <Toast :message="message" :type="messageType || 'info'" @dismiss="clearMessage" />

      <Transition name="unsaved-fade">
        <div v-if="hasPendingWork" class="unsaved-indicator">
          <Loader2 v-if="activeFileStageCount > 0" :size="14" class="unsaved-spinner" />
          <span v-else class="unsaved-dot" />
          <span v-if="activeFileStageCount > 0">正在暂存 {{ activeFileStageCount }} 个文件</span>
          <span v-else>有未保存的更改</span>
          <button
            v-if="activeFileStageCount === 0"
            type="button"
            class="unsaved-revert"
            title="撤销更改"
            @click="requestRevert"
          >
            <Undo2 :size="14" />
          </button>
        </div>
      </Transition>
    </main>

    <ConfirmModal
      :visible="showSaveConfirm"
      title="保存这些更改?"
      cancel-text="取消"
      confirm-text="确定保存"
      @cancel="showSaveConfirm = false"
      @confirm="confirmSave"
    >
      <p>保存后会开始更新网站，线上播放器会在构建完成后生效。</p>
      <ul class="save-summary">
        <li>更新站点配置</li>
        <li v-if="referencedStagedUploads.length > 0">
          发布 {{ referencedStagedUploads.length }} 个新上传或替换的文件
        </li>
        <li v-if="pendingDeletionPaths.length > 0">
          清理 {{ pendingDeletionPaths.length }} 个已不再使用的旧文件
        </li>
      </ul>
      <p class="save-note">配置和文件会一起生效，不会只更新其中一部分。</p>
    </ConfirmModal>

    <ConfirmModal
      :visible="showRevertConfirm"
      title="撤销未保存的更改?"
      cancel-text="取消"
      confirm-text="确认撤销"
      danger
      @cancel="showRevertConfirm = false"
      @confirm="confirmRevert"
    >
      <p>会恢复到上一次成功保存的内容；当前修改和未发布文件都会被丢弃，不会影响线上网站。</p>
    </ConfirmModal>

    <ConfirmModal
      :visible="showExitConfirm"
      title="有未保存的更改"
      cancel-text="留下"
      confirm-text="放弃更改并离开"
      danger
      @cancel="showExitConfirm = false"
      @confirm="confirmExit"
    >
      <p>当前有未保存的修改或仍在暂存的文件，离开后这些内容会丢失。确定要离开吗?</p>
    </ConfirmModal>
  </div>
</template>

<style scoped lang="scss">
  .dashboard-shell {
    flex: 1;
    min-width: 0;
    display: flex;
    overflow: hidden;
  }

  .dashboard-content {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 24px 28px;
    position: relative;
  }

  .content-loading {
    color: var(--text-subtle);
    font-size: 0.88rem;
    padding: 60px 0;
    text-align: center;
  }

  .tab-wrapper {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .admin-section {
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.11);
    border-radius: 22px;
    background: rgba(255, 255, 255, 0.075);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.045);
    backdrop-filter: blur(22px);
    padding-bottom: 14px;
  }

  .section-title {
    margin: 0;
    padding: 12px 14px 10px;
    color: rgba(255, 255, 255, 0.48);
    font-size: 0.62rem;
    font-weight: 680;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .unsaved-indicator {
    position: fixed;
    bottom: 20px;
    right: 28px;
    display: flex;
    align-items: center;
    gap: 7px;
    max-width: calc(100vw - 56px);
    padding: 8px 10px 8px 14px;
    border-radius: 12px;
    background: rgba(255, 180, 0, 0.15);
    border: 1px solid rgba(255, 180, 0, 0.3);
    backdrop-filter: blur(22px);
    color: #ffc04a;
    font-size: 0.76rem;
    font-weight: 540;
    z-index: 50;
  }

  .unsaved-revert {
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-left: 2px;
    border: 1px solid rgba(255, 192, 74, 0.28);
    border-radius: 9px;
    background: rgba(255, 192, 74, 0.1);
    color: #ffc04a;
    cursor: pointer;
    transition:
      background 0.2s cubic-bezier(0.16, 1, 0.3, 1),
      border-color 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      background: rgba(255, 192, 74, 0.18);
      border-color: rgba(255, 192, 74, 0.42);
    }
  }

  .unsaved-fade-enter-active,
  .unsaved-fade-leave-active {
    transition:
      opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1),
      transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .unsaved-fade-enter-from,
  .unsaved-fade-leave-to {
    opacity: 0;
    transform: translateY(10px) scale(0.98);
  }

  .unsaved-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #ffc04a;
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }

  .unsaved-spinner {
    flex-shrink: 0;
    animation: spin 0.9s linear infinite;
  }

  .save-summary {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 12px 0;
    padding: 10px 12px 10px 30px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.045);
    color: rgba(255, 255, 255, 0.82);
  }

  .save-note {
    color: rgba(255, 255, 255, 0.68);
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .tab-fade-enter-active,
  .tab-fade-leave-active {
    transition:
      opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1),
      transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .tab-fade-enter-from {
    opacity: 0;
    transform: translateY(8px);
  }

  .tab-fade-leave-to {
    opacity: 0;
    transform: translateY(-4px);
  }

  @media (max-width: 760px) {
    .dashboard-shell {
      flex-direction: column;
    }

    .dashboard-content {
      flex: 1 1 auto;
      min-height: 0;
      padding: 14px 12px calc(86px + env(safe-area-inset-bottom));
      -webkit-overflow-scrolling: touch;
    }

    .admin-section {
      border-radius: 16px;
      padding-bottom: 10px;
    }

    .section-title {
      padding: 11px 12px 9px;
      font-size: 0.58rem;
    }

    .unsaved-indicator {
      right: 12px;
      bottom: max(12px, env(safe-area-inset-bottom));
      left: 12px;
      justify-content: center;
      max-width: none;
      padding: 9px 10px 9px 12px;
      border-radius: 14px;
      font-size: 0.72rem;
    }
  }
</style>
