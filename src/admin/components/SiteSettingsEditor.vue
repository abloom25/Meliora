<script setup lang="ts">
  import { ref, computed } from 'vue'
  import { Check, Loader2, PlugZap, Upload, X } from '@lucide/vue'
  import type { MusicConfig } from '../../types/music'
  import BaseInput from '../../components/BaseInput.vue'
  import {
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_SIZE_LABEL,
    testMusicApi,
    uploadFile,
    type MusicApiTestResult,
  } from '../services/admin-api'

  const props = defineProps<{ config: MusicConfig }>()
  const emit = defineEmits<{
    'update:config': [value: MusicConfig]
    notify: [message: string, type: 'success' | 'error']
  }>()

  const iconUrlInput = ref(props.config.siteIcon || '')
  const uploadStatus = ref('')
  const testingApi = ref(false)
  const apiTestStatus = ref<'idle' | 'success' | 'error'>('idle')
  const apiTestResult = ref<MusicApiTestResult | null>(null)

  const siteName = computed({
    get: () => props.config.siteName,
    set: (value: string) => emit('update:config', { ...props.config, siteName: value }),
  })

  const apiEndpoint = computed({
    get: () => props.config.apiEndpoint,
    set: (value: string) => emit('update:config', { ...props.config, apiEndpoint: value }),
  })

  const showApiToken = ref(false)

  function setApiToken(value: string) {
    const patch = value.trim()
      ? { ...props.config, apiToken: value }
      : (() => {
          const { apiToken, ...rest } = props.config
          void apiToken
          return rest
        })()
    emit('update:config', patch)
  }

  async function testApiEndpoint() {
    if (testingApi.value) return

    testingApi.value = true
    apiTestStatus.value = 'idle'
    apiTestResult.value = null

    try {
      const result = await testMusicApi(props.config)
      apiTestResult.value = result.data || null
      if (result.ok && result.data) {
        apiTestStatus.value = 'success'
        emit(
          'notify',
          `全部 ${result.data.playlistCount} 个歌单测试通过,共 ${result.data.trackCount} 首`,
          'success',
        )
      } else {
        apiTestStatus.value = 'error'
        emit('notify', result.error || '测试失败', 'error')
      }
    } catch {
      apiTestStatus.value = 'error'
      emit('notify', '网络错误', 'error')
    } finally {
      testingApi.value = false
    }
  }

  function setIcon(value: string | undefined) {
    iconUrlInput.value = value || ''
    emit('update:config', { ...props.config, siteIcon: value })
  }

  function readFileAsBase64(file: File): Promise<{ base64: string; dataUrl: string }> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : ''
        const base64 = dataUrl.split(',')[1] || ''
        if (!base64) {
          reject(new Error('empty file result'))
          return
        }
        resolve({ base64, dataUrl })
      }
      reader.onerror = () => reject(reader.error || new Error('file read failed'))
      reader.onabort = () => reject(new Error('file read aborted'))
      reader.readAsDataURL(file)
    })
  }

  async function handleIconUpload(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    if (file.size > MAX_UPLOAD_BYTES) {
      uploadStatus.value = `文件过大,最大 ${MAX_UPLOAD_SIZE_LABEL}`
      input.value = ''
      window.setTimeout(() => {
        uploadStatus.value = ''
      }, 3000)
      return
    }

    uploadStatus.value = '上传中...'
    try {
      const { base64, dataUrl } = await readFileAsBase64(file)
      const ext = file.name.split('.').pop()?.toLowerCase() || 'png'
      const path = `public/icon.${ext}`
      const result = await uploadFile(path, base64)
      if (result.ok) {
        setIcon(result.local && import.meta.env.DEV ? dataUrl : `./icon.${ext}`)
        uploadStatus.value = '上传成功'
      } else {
        uploadStatus.value = result.error || '上传失败'
      }
    } catch {
      uploadStatus.value = '读取失败'
    } finally {
      input.value = ''
      window.setTimeout(() => {
        uploadStatus.value = ''
      }, 3000)
    }
  }

  function applyIconUrl() {
    const nextIcon = iconUrlInput.value.trim()
    setIcon(nextIcon || undefined)
  }
</script>

<template>
  <div class="site-editor">
    <div class="admin-section">
      <h3 class="section-title">站点信息</h3>

      <div class="setting-row">
        <span class="row-label"><strong>站点名称</strong></span>
        <BaseInput v-model="siteName" type="text" placeholder="Meliora" />
      </div>

      <div class="setting-row icon-row">
        <span class="row-label"><strong>站点图标</strong><small>显示在浏览器标签页</small></span>
        <div class="icon-control">
          <div class="icon-preview">
            <img
              v-if="config.siteIcon"
              :src="config.siteIcon"
              alt="站点图标"
              @error="setIcon(undefined)"
            />
            <Upload v-else :size="18" />
          </div>

          <div class="icon-input-group">
            <BaseInput
              v-model="iconUrlInput"
              type="url"
              placeholder="图标 URL 或上传文件"
              @blur="applyIconUrl"
              @keydown.enter.prevent="applyIconUrl"
            />
            <label class="icon-action" title="上传图标">
              <Upload :size="15" />
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon"
                @change="handleIconUpload"
              />
            </label>
            <button
              v-if="config.siteIcon"
              type="button"
              class="icon-action clear"
              title="清除图标"
              @click="setIcon(undefined)"
            >
              <X :size="15" />
            </button>
          </div>
          <small v-if="uploadStatus" class="upload-status">{{ uploadStatus }}</small>
        </div>
      </div>
    </div>

    <div class="admin-section">
      <h3 class="section-title">API 配置</h3>

      <div class="setting-row">
        <span class="row-label"><strong>API 端点</strong></span>
        <BaseInput v-model="apiEndpoint" type="url" placeholder="https://api.example.com/api" />
      </div>

      <div class="setting-row">
        <span class="row-label">
          <strong>API Token</strong>
          <small>部分 Meting API 需要鉴权</small>
        </span>
        <div class="token-field">
          <BaseInput
            :model-value="config.apiToken || ''"
            :type="showApiToken ? 'text' : 'password'"
            placeholder="可选"
            @update:model-value="setApiToken($event)"
          />
          <button type="button" class="token-toggle" @click="showApiToken = !showApiToken">
            {{ showApiToken ? '隐藏' : '显示' }}
          </button>
        </div>
      </div>

      <div class="setting-row api-test-row">
        <span class="row-label">
          <strong>连通测试</strong>
          <small>测试全部启用歌单接口</small>
        </span>
        <button
          type="button"
          class="api-test-button"
          :class="apiTestStatus"
          :disabled="testingApi"
          @click="testApiEndpoint"
        >
          <span>
            {{
              testingApi
                ? '测试中'
                : apiTestStatus === 'success'
                  ? '测试通过'
                  : apiTestStatus === 'error'
                    ? '测试失败'
                    : '测试接口'
            }}
          </span>
          <Loader2 v-if="testingApi" :size="14" class="spin" />
          <Check v-else-if="apiTestStatus === 'success'" :size="14" />
          <PlugZap v-else :size="14" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
  .site-editor {
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

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 15px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.075);
  }

  .row-label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex-shrink: 0;

    strong {
      color: #fff;
      font-size: 0.86rem;
      font-weight: 560;
    }

    small {
      color: var(--text-subtle);
      font-size: 0.7rem;
    }
  }

  .token-field {
    display: flex;
    gap: 8px;
    align-items: center;
    flex: 1;
    max-width: 320px;

    :deep(.base-input) {
      max-width: none;
    }
  }

  .api-test-row {
    align-items: center;
  }

  .api-test-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 36px;
    min-width: 78px;
    padding: 0 12px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 11px;
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.78);
    font-size: 0.76rem;
    font-weight: 560;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.12);
      color: #fff;
    }

    &:disabled {
      opacity: 0.68;
      cursor: not-allowed;
    }

    &.success {
      border-color: rgba(109, 213, 140, 0.28);
      background: rgba(109, 213, 140, 0.12);
      color: #6dd58c;
    }

    &.error {
      border-color: rgba(255, 139, 139, 0.3);
      background: rgba(255, 139, 139, 0.12);
      color: #ff8b8b;
    }
  }

  .spin {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .token-toggle {
    padding: 8px 12px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 11px;
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.74rem;
    cursor: pointer;
    flex-shrink: 0;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      background: rgba(255, 255, 255, 0.12);
      color: rgba(255, 255, 255, 0.85);
    }
  }

  .icon-control {
    display: grid;
    grid-template-columns: 48px minmax(0, 320px);
    align-items: center;
    gap: 10px;
    flex: 1;
    justify-content: end;
  }

  .icon-preview {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    color: var(--text-subtle);

    img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
  }

  .icon-input-group {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;

    :deep(.base-input) {
      max-width: none;
    }
  }

  .icon-action {
    width: 34px;
    height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.82);
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    input[type='file'] {
      display: none;
    }

    &:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.22);
      color: #fff;
    }

    &.clear {
      color: rgba(255, 139, 139, 0.86);

      &:hover {
        background: rgba(255, 139, 139, 0.12);
        border-color: rgba(255, 139, 139, 0.28);
      }
    }
  }

  .upload-status {
    grid-column: 2;
    color: var(--accent);
    font-size: 0.72rem;
  }

  @media (max-width: 720px) {
    .site-editor {
      gap: 12px;
    }

    .admin-section {
      border-radius: 16px;
    }

    .section-title {
      padding: 11px 12px 9px;
      font-size: 0.58rem;
    }

    .setting-row {
      align-items: stretch;
      flex-direction: column;
      gap: 10px;
      padding: 13px 12px;
    }

    .row-label {
      flex-shrink: 1;
      min-width: 0;

      small {
        line-height: 1.4;
      }
    }

    .token-field {
      width: 100%;
      max-width: none;
    }

    .icon-control {
      grid-template-columns: 48px minmax(0, 1fr);
      width: 100%;
      justify-content: stretch;
    }

    .icon-input-group {
      min-width: 0;
    }

    .upload-status {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 420px) {
    .token-field,
    .icon-input-group {
      align-items: stretch;
      flex-direction: column;
    }

    .token-toggle {
      width: 100%;
    }

    .icon-action {
      width: 100%;
      height: 36px;
    }
  }
</style>
