<script setup lang="ts">
  import { onBeforeUnmount, ref } from 'vue'
  import { ChevronDown, Plus, Trash2, Upload } from '@lucide/vue'
  import type { LocalTrackConfig } from '../../types/music'
  import {
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_SIZE_LABEL,
    uploadFile,
    type StagedUpload,
  } from '../services/admin-api'
  import ConfirmModal from './ConfirmModal.vue'
  import Collapse from '../../components/Collapse.vue'
  import BaseInput from '../../components/BaseInput.vue'
  import { useFileStagingState } from '../composables/useFileStagingState'

  const props = defineProps<{ tracks: LocalTrackConfig[] }>()
  const emit = defineEmits<{
    'update:tracks': [value: LocalTrackConfig[]]
    'file-staged': [value: StagedUpload]
  }>()

  const expanded = ref<number | null>(null)
  const pendingRemoveIndex = ref<number | null>(null)
  const uploadStatus = ref<Record<string, string>>({})
  const uploadingKeys = ref<Set<string>>(new Set())
  const statusTimers = new Map<string, number>()
  const { beginFileStaging } = useFileStagingState()

  onBeforeUnmount(() => {
    for (const timer of statusTimers.values()) window.clearTimeout(timer)
    statusTimers.clear()
  })

  function isUploading(key: string): boolean {
    return uploadingKeys.value.has(key)
  }

  function uploadKey(
    track: LocalTrackConfig,
    index: number,
    role: 'audio' | 'cover' | 'lyrics',
  ): string {
    return `${track.id || `index-${index}`}-${role}`
  }

  function setUploading(key: string, uploading: boolean) {
    const next = new Set(uploadingKeys.value)
    if (uploading) next.add(key)
    else next.delete(key)
    uploadingKeys.value = next
  }

  function clearStatusLater(key: string) {
    const existing = statusTimers.get(key)
    if (existing !== undefined) window.clearTimeout(existing)
    statusTimers.set(
      key,
      window.setTimeout(() => {
        const next = { ...uploadStatus.value }
        delete next[key]
        uploadStatus.value = next
        statusTimers.delete(key)
      }, 3000),
    )
  }

  function update(index: number, patch: Partial<LocalTrackConfig>) {
    const next = props.tracks.map((item, i) => (i === index ? { ...item, ...patch } : item))
    emit('update:tracks', next)
  }

  function add() {
    const id = `track-${Date.now()}`
    emit('update:tracks', [...props.tracks, { id, title: '', artist: '', audio: '' }])
    expanded.value = props.tracks.length
  }

  function remove(index: number) {
    if (!props.tracks[index]) return
    emit(
      'update:tracks',
      props.tracks.filter((_, i) => i !== index),
    )
    if (expanded.value === index) expanded.value = null
    if (expanded.value !== null && expanded.value > index) expanded.value -= 1
  }

  function requestRemove(index: number) {
    pendingRemoveIndex.value = index
  }

  function cancelRemove() {
    pendingRemoveIndex.value = null
  }

  function confirmRemove() {
    if (pendingRemoveIndex.value === null) return
    const index = pendingRemoveIndex.value
    remove(index)
    pendingRemoveIndex.value = null
  }

  function getIncompleteReason(track: LocalTrackConfig): string {
    if (!track.id.trim()) return '请先填写曲目 ID'
    if (!track.title.trim()) return '请填写曲目标题'
    if (!track.artist.trim()) return '请填写艺术家'
    if (!track.audio.trim()) return '请上传音频文件'
    return ''
  }

  function getExt(filename: string): string {
    const dot = filename.lastIndexOf('.')
    return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : 'bin'
  }

  function readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result as string
        const base64 = result.split(',')[1] || ''
        resolve(base64)
      }
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
  }

  async function handleFile(index: number, role: 'audio' | 'cover' | 'lyrics', event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    const track = props.tracks[index]
    if (!track) {
      input.value = ''
      return
    }
    const key = uploadKey(track, index, role)
    if (isUploading(key)) {
      input.value = ''
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      uploadStatus.value[key] = `文件过大(>${MAX_UPLOAD_SIZE_LABEL})`
      input.value = ''
      clearStatusLater(key)
      return
    }

    if (!track.id) {
      uploadStatus.value[key] = '请先填写曲目 ID'
      input.value = ''
      clearStatusLater(key)
      return
    }

    const finishFileStaging = beginFileStaging()
    setUploading(key, true)
    uploadStatus.value[key] = '正在暂存...'
    try {
      const base64 = await readFileAsBase64(file)
      const ext = getExt(file.name)
      const path = `public/music/${track.id}/${role}.${ext}`
      const result = await uploadFile(path, base64)
      if (result.ok && result.blobSha && result.path) {
        const currentIndex = props.tracks.findIndex(
          (item) => item === track || item.id === track.id,
        )
        if (currentIndex < 0) {
          uploadStatus.value[key] = '曲目已被修改,暂存文件未加入配置'
          return
        }
        emit('file-staged', { path: result.path, blobSha: result.blobSha })
        update(currentIndex, { [role]: `./music/${track.id}/${role}.${ext}` })
        uploadStatus.value[key] = '已暂存，保存全部后生效'
      } else {
        uploadStatus.value[key] = result.error || '上传失败'
      }
    } catch {
      uploadStatus.value[key] = '读取文件失败'
    } finally {
      input.value = ''
      setUploading(key, false)
      finishFileStaging()
      clearStatusLater(key)
    }
  }
</script>

<template>
  <div class="local-editor">
    <Transition name="fade">
      <div v-if="!tracks.length" class="empty">暂无本地音乐,点击下方添加</div>
    </Transition>

    <TransitionGroup name="list" tag="div" class="track-list">
      <Collapse
        v-for="(track, index) in tracks"
        :key="track.id"
        class="track-card"
        :expanded="expanded === index"
        @update:expanded="(v) => (expanded = v ? index : null)"
      >
        <template #trigger="{ toggle }">
          <div class="track-header" @click="toggle">
            <div class="track-summary">
              <strong>{{ track.title || '未命名曲目' }}</strong>
              <small>{{ track.artist || '未知艺术家' }}</small>
            </div>
            <div class="track-actions">
              <ChevronDown :size="16" class="chevron" :class="{ collapsed: expanded !== index }" />
            </div>
          </div>
        </template>

        <div class="track-body">
          <p v-if="getIncompleteReason(track)" class="track-warning">
            {{ getIncompleteReason(track) }}。未补全前保存会被拦截。
          </p>

          <label class="field">
            <span>ID(用作文件夹名)</span>
            <BaseInput
              :model-value="track.id"
              type="text"
              placeholder="track-id"
              @update:model-value="update(index, { id: $event })"
            />
          </label>
          <label class="field">
            <span>标题</span>
            <BaseInput
              :model-value="track.title"
              type="text"
              @update:model-value="update(index, { title: $event })"
            />
          </label>
          <label class="field">
            <span>艺术家</span>
            <BaseInput
              :model-value="track.artist"
              type="text"
              @update:model-value="update(index, { artist: $event })"
            />
          </label>
          <label class="field">
            <span>专辑(可选)</span>
            <BaseInput
              :model-value="track.album || ''"
              type="text"
              @update:model-value="update(index, { album: $event })"
            />
          </label>

          <div class="upload-grid">
            <div class="upload-cell">
              <span>音频 *</span>
              <small v-if="track.audio">{{ track.audio }}</small>
              <label
                class="upload-button"
                :class="{ disabled: isUploading(uploadKey(track, index, 'audio')) }"
              >
                <Upload :size="13" />
                <span>{{ track.audio ? '替换音频' : '上传音频' }}</span>
                <input
                  type="file"
                  accept="audio/*"
                  :disabled="isUploading(uploadKey(track, index, 'audio'))"
                  @change="handleFile(index, 'audio', $event)"
                />
              </label>
              <small v-if="uploadStatus[uploadKey(track, index, 'audio')]" class="upload-status">
                {{ uploadStatus[uploadKey(track, index, 'audio')] }}
              </small>
            </div>

            <div class="upload-cell">
              <span>封面(可选)</span>
              <small v-if="track.cover">{{ track.cover }}</small>
              <label
                class="upload-button"
                :class="{ disabled: isUploading(uploadKey(track, index, 'cover')) }"
              >
                <Upload :size="13" />
                <span>{{ track.cover ? '替换封面' : '上传封面' }}</span>
                <input
                  type="file"
                  accept="image/*"
                  :disabled="isUploading(uploadKey(track, index, 'cover'))"
                  @change="handleFile(index, 'cover', $event)"
                />
              </label>
              <small v-if="uploadStatus[uploadKey(track, index, 'cover')]" class="upload-status">
                {{ uploadStatus[uploadKey(track, index, 'cover')] }}
              </small>
            </div>

            <div class="upload-cell">
              <span>歌词 LRC(可选)</span>
              <small v-if="track.lyrics">{{ track.lyrics }}</small>
              <label
                class="upload-button"
                :class="{ disabled: isUploading(uploadKey(track, index, 'lyrics')) }"
              >
                <Upload :size="13" />
                <span>{{ track.lyrics ? '替换歌词' : '上传歌词' }}</span>
                <input
                  type="file"
                  accept=".lrc,text/plain"
                  :disabled="isUploading(uploadKey(track, index, 'lyrics'))"
                  @change="handleFile(index, 'lyrics', $event)"
                />
              </label>
              <small v-if="uploadStatus[uploadKey(track, index, 'lyrics')]" class="upload-status">
                {{ uploadStatus[uploadKey(track, index, 'lyrics')] }}
              </small>
            </div>
          </div>

          <div class="danger-zone">
            <span>
              <strong>从草稿移除</strong>
              <small>保存前可以撤销，不会立刻影响线上音乐</small>
            </span>
            <button class="remove-button" type="button" @click="requestRemove(index)">
              <Trash2 :size="14" />
              <span>移除</span>
            </button>
          </div>
        </div>
      </Collapse>
    </TransitionGroup>

    <button class="add-button" type="button" @click="add">
      <Plus :size="15" />
      <span>添加本地曲目</span>
    </button>

    <ConfirmModal
      :visible="pendingRemoveIndex !== null"
      title="从草稿移除这首音乐?"
      cancel-text="取消"
      confirm-text="确认移除"
      danger
      @cancel="cancelRemove"
      @confirm="confirmRemove"
    >
      <p>
        将移除
        <strong>
          {{
            tracks[pendingRemoveIndex ?? 0]?.title ||
            tracks[pendingRemoveIndex ?? 0]?.id ||
            '未命名曲目'
          }}
        </strong>
        。现在只会修改当前草稿，不会立刻影响线上网站。保存后，这首音乐和不再使用的关联文件会一起移除；保存前仍可撤销。
      </p>
    </ConfirmModal>
  </div>
</template>

<style scoped lang="scss">
  .local-editor {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 0 14px;
  }

  .track-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .empty {
    color: var(--text-subtle);
    font-size: 0.8rem;
    padding: 10px 0;
  }

  .track-card {
    background: rgba(0, 0, 0, 0.18);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    overflow: hidden;
  }

  .track-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    cursor: pointer;
    transition: background 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      background: rgba(255, 255, 255, 0.04);
    }
  }

  .track-summary {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;

    strong {
      color: #fff;
      font-size: 0.88rem;
      font-weight: 560;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    small {
      color: var(--text-subtle);
      font-size: 0.72rem;
    }
  }

  .track-actions {
    display: inline-flex;
    align-items: center;
    color: var(--text-subtle);
  }

  .chevron {
    transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);

    &.collapsed {
      transform: rotate(-90deg);
    }
  }

  .remove-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 32px;
    padding: 0 11px;
    border: 1px solid rgba(255, 139, 139, 0.3);
    border-radius: 8px;
    background: rgba(255, 139, 139, 0.1);
    color: #ff8b8b;
    font-size: 0.74rem;
    font-weight: 560;
    cursor: pointer;

    &:hover {
      background: rgba(255, 139, 139, 0.2);
    }
  }

  .track-body {
    overflow: hidden;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;

    span {
      color: var(--text-subtle);
      font-size: 0.72rem;
    }
  }

  .track-warning {
    margin: 0;
    padding: 8px 10px;
    border: 1px solid rgba(255, 192, 74, 0.28);
    border-radius: 9px;
    background: rgba(255, 192, 74, 0.1);
    color: #ffc04a;
    font-size: 0.72rem;
    line-height: 1.45;
  }

  .upload-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
    margin-top: 4px;
  }

  .upload-cell {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 10px;
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;

    > span {
      color: var(--text-subtle);
      font-size: 0.7rem;
    }

    > small {
      color: rgba(255, 255, 255, 0.6);
      font-size: 0.68rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .upload-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 7px 10px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 9px;
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.85);
    font-size: 0.72rem;
    cursor: pointer;
    transition: background 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      background: rgba(255, 255, 255, 0.12);
    }

    &.disabled {
      opacity: 0.55;
      cursor: wait;
      pointer-events: none;
    }

    input[type='file'] {
      display: none;
    }
  }

  .upload-status {
    color: var(--accent);
    font-size: 0.68rem;
  }

  .danger-zone {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    margin-top: 2px;
    padding: 10px;
    border: 1px solid rgba(255, 139, 139, 0.16);
    border-radius: 10px;
    background: rgba(255, 139, 139, 0.06);

    > span {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;

      strong {
        color: rgba(255, 216, 216, 0.9);
        font-size: 0.76rem;
        font-weight: 560;
      }

      small {
        color: rgba(255, 216, 216, 0.54);
        font-size: 0.68rem;
        line-height: 1.45;
      }
    }
  }

  .add-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 14px;
    border: 1px dashed rgba(255, 255, 255, 0.2);
    border-radius: 12px;
    background: transparent;
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.82rem;
    cursor: pointer;

    &:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.3);
    }
  }

  .list-enter-active,
  .list-leave-active {
    transition:
      opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1),
      transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .list-enter-from {
    opacity: 0;
    transform: translateY(-8px) scale(0.98);
  }

  .list-leave-to {
    opacity: 0;
    transform: scale(0.95);
  }

  .list-leave-active {
    position: absolute;
    width: calc(100% - 0px);
  }

  .list-move {
    transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .fade-enter-active,
  .fade-leave-active {
    transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .fade-enter-from,
  .fade-leave-to {
    opacity: 0;
  }

  @media (max-width: 640px) {
    .danger-zone {
      align-items: stretch;
      flex-direction: column;
    }

    .remove-button {
      width: 100%;
    }
  }
</style>
