<script setup lang="ts">
  import { ref } from 'vue'
  import { Download, Upload } from '@lucide/vue'
  import type { MusicConfig } from '../../types/music'
  import { validateMusicConfig } from '../../../shared/config-schema'
  import ConfirmModal from '../components/ConfirmModal.vue'

  const props = defineProps<{
    config: MusicConfig
  }>()

  const emit = defineEmits<{
    'update:config': [value: MusicConfig]
    notify: [message: string, type: 'success' | 'error']
  }>()

  const importInputRef = ref<HTMLInputElement | null>(null)
  const showExportRiskConfirm = ref(false)
  const showImportOverwriteConfirm = ref(false)
  const pendingImportConfig = ref<MusicConfig | null>(null)

  function getExportFileName(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    return `meliora-config-plain-${stamp}.json`
  }

  function downloadTextFile(filename: string, content: string) {
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  function exportPlainConfig() {
    showExportRiskConfirm.value = true
  }

  function confirmExportPlainConfig() {
    showExportRiskConfirm.value = false
    const validation = validateMusicConfig(props.config)
    if (!validation.valid || !validation.config) {
      emit('notify', `当前配置未通过校验:${validation.errors.join('; ')}`, 'error')
      return
    }

    downloadTextFile(getExportFileName(), `${JSON.stringify(validation.config, null, 2)}\n`)
    emit('notify', '已导出未加密配置 JSON', 'success')
  }

  function requestImportPlainConfig() {
    importInputRef.value?.click()
  }

  async function importPlainConfig(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return

    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      emit('notify', '导入失败:JSON 格式无效', 'error')
      return
    }

    const validation = validateMusicConfig(parsed)
    if (!validation.valid || !validation.config) {
      emit('notify', `导入失败:${validation.errors.join('; ')}`, 'error')
      return
    }

    pendingImportConfig.value = validation.config
    showImportOverwriteConfirm.value = true
  }

  function confirmImportPlainConfig() {
    if (!pendingImportConfig.value) {
      showImportOverwriteConfirm.value = false
      return
    }

    emit('update:config', pendingImportConfig.value)
    pendingImportConfig.value = null
    showImportOverwriteConfirm.value = false
    emit('notify', '已导入未加密配置,确认无误后请保存', 'success')
  }

  function cancelImportPlainConfig() {
    pendingImportConfig.value = null
    showImportOverwriteConfirm.value = false
  }
</script>

<template>
  <div class="transfer-root">
    <section class="transfer-page">
      <div class="transfer-header">
        <h2>配置迁移</h2>
      </div>

      <div class="transfer-grid">
        <article class="transfer-panel">
          <div class="panel-title">
            <Download :size="18" />
            <h3>导出未加密配置</h3>
          </div>
          <button type="button" class="transfer-primary" @click="exportPlainConfig">
            <Download :size="16" />
            <span>导出 JSON</span>
          </button>
        </article>

        <article class="transfer-panel">
          <div class="panel-title">
            <Upload :size="18" />
            <h3>导入未加密配置</h3>
          </div>
          <button type="button" class="transfer-primary" @click="requestImportPlainConfig">
            <Upload :size="16" />
            <span>选择 JSON</span>
          </button>
          <input
            ref="importInputRef"
            class="visually-hidden"
            type="file"
            accept="application/json,.json"
            @change="importPlainConfig"
          />
        </article>
      </div>
    </section>

    <ConfirmModal
      :visible="showExportRiskConfirm"
      title="导出未加密配置?"
      cancel-text="取消"
      confirm-text="确认导出"
      danger
      width="min(460px, calc(100vw - 36px))"
      @cancel="showExportRiskConfirm = false"
      @confirm="confirmExportPlainConfig"
    >
      <p>
        导出的 JSON 是明文文件,会包含站点配置、音乐 API Token、GitHub
        代理设置等敏感配置字段。请妥善保存,
        不要上传到公开仓库或发送给不可信的人。管理员登录密码不会以明文保存,因此无法从后台反向导出。
      </p>
    </ConfirmModal>

    <ConfirmModal
      :visible="showImportOverwriteConfirm"
      title="覆盖当前配置?"
      cancel-text="取消"
      confirm-text="确认覆盖"
      danger
      width="min(460px, calc(100vw - 36px))"
      @cancel="cancelImportPlainConfig"
      @confirm="confirmImportPlainConfig"
    >
      <p>
        导入会用所选 JSON
        覆盖当前后台表单中的配置。覆盖后不会自动保存到仓库,但当前未保存的编辑会被替换。
        请确认已经备份或不再需要当前改动。
      </p>
    </ConfirmModal>
  </div>
</template>

<style scoped lang="scss">
  .transfer-root {
    display: block;
  }

  .transfer-page {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .transfer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;

    h2 {
      margin: 0;
      color: rgba(255, 255, 255, 0.92);
      font-size: 1.05rem;
      font-weight: 720;
    }
  }

  .transfer-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  .transfer-panel {
    display: flex;
    min-height: 150px;
    flex-direction: column;
    justify-content: space-between;
    gap: 18px;
    border: 1px solid rgba(255, 255, 255, 0.11);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.075);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.045);
    padding: 16px;
  }

  .panel-title {
    display: flex;
    align-items: center;
    gap: 9px;
    color: var(--accent);

    h3 {
      margin: 0;
      color: rgba(255, 255, 255, 0.86);
      font-size: 0.92rem;
      font-weight: 680;
    }
  }

  .transfer-primary {
    display: inline-flex;
    min-height: 38px;
    align-items: center;
    justify-content: center;
    gap: 8px;
    align-self: flex-start;
    padding: 9px 13px;
    border: none;
    border-radius: 8px;
    background: var(--accent);
    color: #0e0d12;
    font-size: 0.82rem;
    font-weight: 700;
    cursor: pointer;
    transition: filter 0.18s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      filter: brightness(1.1);
    }
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (max-width: 760px) {
    .transfer-grid {
      grid-template-columns: 1fr;
      gap: 10px;
    }

    .transfer-panel {
      min-height: 132px;
      padding: 14px;
    }
  }
</style>
