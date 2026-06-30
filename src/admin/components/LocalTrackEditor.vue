<script setup lang="ts">
  import { ref } from 'vue'
  import { ChevronDown, Plus, Trash2, Upload } from '@lucide/vue'
  import type { LocalTrackConfig } from '../../types/music'
  import {
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_SIZE_LABEL,
    uploadFile,
    deleteFiles,
  } from '../services/admin-api'
  import ConfirmModal from './ConfirmModal.vue'
  import Collapse from '../../components/Collapse.vue'
  import BaseInput from '../../components/BaseInput.vue'

  const props = defineProps<{ tracks: LocalTrackConfig[] }>()
  const emit = defineEmits<{ 'update:tracks': [value: LocalTrackConfig[]] }>()

  const expanded = ref<number | null>(null)
  const pendingRemoveIndex = ref<number | null>(null)
  const removingIndex = ref<number | null>(null)
  const removeStatus = ref('')
  const uploadStatus = ref<Record<string, string>>({})

  function update(index: number, patch: Partial<LocalTrackConfig>) {
    const next = props.tracks.map((item, i) => (i === index ? { ...item, ...patch } : item))
    emit('update:tracks', next)
  }

  function add() {
    const id = `track-${Date.now()}`
    emit('update:tracks', [...props.tracks, { id, title: '', artist: '', audio: '' }])
    expanded.value = props.tracks.length
  }

  async function remove(index: number) {
    const track = props.tracks[index]
    if (!track) return
    const paths: string[] = []
    if (track.audio?.startsWith('./music/')) paths.push(`public${track.audio.slice(1)}`)
    if (track.cover?.startsWith('./music/')) paths.push(`public${track.cover.slice(1)}`)
    if (track.lyrics?.startsWith('./music/')) paths.push(`public${track.lyrics.slice(1)}`)
    if (paths.length) {
      const result = await deleteFiles(paths)
      if (!result.ok) {
        removeStatus.value = result.error || '部分文件删除失败,曲目未从配置中移除'
        return
      }
    }
    emit(
      'update:tracks',
      props.tracks.filter((_, i) => i !== index),
    )
    if (expanded.value === index) expanded.value = null
    if (expanded.value !== null && expanded.value > index) expanded.value -= 1
  }

  function requestRemove(index: number) {
    removeStatus.value = ''
    pendingRemoveIndex.value = index
  }

  function cancelRemove() {
    removeStatus.value = ''
    pendingRemoveIndex.value = null
  }

  async function confirmRemove() {
    if (pendingRemoveIndex.value === null || removingIndex.value !== null) return
    const index = pendingRemoveIndex.value
    removingIndex.value = index
    try {
      await remove(index)
      if (!removeStatus.value) {
        pendingRemoveIndex.value = null
      }
    } finally {
      removingIndex.value = null
    }
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

    const key = `${index}-${role}`
    if (file.size > MAX_UPLOAD_BYTES) {
      uploadStatus.value[key] = `文件过大(>${MAX_UPLOAD_SIZE_LABEL})`
      input.value = ''
      return
    }

    const track = props.tracks[index]
    if (!track.id) {
      uploadStatus.value[key] = '请先填写曲目 ID'
      input.value = ''
      return
    }

    uploadStatus.value[key] = '上传中...'
    try {
      const base64 = await readFileAsBase64(file)
      const ext = getExt(file.name)
      const path = `public/music/${track.id}/${role}.${ext}`
      const result = await uploadFile(path, base64)
      if (result.ok) {
        update(index, { [role]: `./music/${track.id}/${role}.${ext}` })
        uploadStatus.value[key] = '上传成功'
      } else {
        uploadStatus.value[key] = result.error || '上传失败'
      }
    } catch {
      uploadStatus.value[key] = '读取文件失败'
    } finally {
      input.value = ''
      window.setTimeout(() => {
        delete uploadStatus.value[key]
      }, 3000)
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
              <label class="upload-button">
                <Upload :size="13" />
                <span>{{ track.audio ? '替换音频' : '上传音频' }}</span>
                <input type="file" accept="audio/*" @change="handleFile(index, 'audio', $event)" />
              </label>
              <small v-if="uploadStatus[`${index}-audio`]" class="upload-status">
                {{ uploadStatus[`${index}-audio`] }}
              </small>
            </div>

            <div class="upload-cell">
              <span>封面(可选)</span>
              <small v-if="track.cover">{{ track.cover }}</small>
              <label class="upload-button">
                <Upload :size="13" />
                <span>{{ track.cover ? '替换封面' : '上传封面' }}</span>
                <input type="file" accept="image/*" @change="handleFile(index, 'cover', $event)" />
              </label>
              <small v-if="uploadStatus[`${index}-cover`]" class="upload-status">
                {{ uploadStatus[`${index}-cover`] }}
              </small>
            </div>

            <div class="upload-cell">
              <span>歌词 LRC(可选)</span>
              <small v-if="track.lyrics">{{ track.lyrics }}</small>
              <label class="upload-button">
                <Upload :size="13" />
                <span>{{ track.lyrics ? '替换歌词' : '上传歌词' }}</span>
                <input
                  type="file"
                  accept=".lrc,text/plain"
                  @change="handleFile(index, 'lyrics', $event)"
                />
              </label>
              <small v-if="uploadStatus[`${index}-lyrics`]" class="upload-status">
                {{ uploadStatus[`${index}-lyrics`] }}
              </small>
            </div>
          </div>

          <div class="danger-zone">
            <span>
              <strong>删除本地曲目</strong>
              <small>会立即删除已上传到本曲目目录的文件,并从当前配置中移除该曲目</small>
            </span>
            <button class="remove-button" type="button" @click="requestRemove(index)">
              <Trash2 :size="14" />
              <span>删除</span>
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
      title="删除这首本地音乐?"
      cancel-text="取消"
      :confirm-text="removingIndex !== null ? '删除中...' : '确认删除'"
      danger
      :loading="removingIndex !== null"
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
        ,并立即删除已上传到该曲目目录的音频、封面和歌词文件。文件删除成功后,曲目会从当前配置中移除。
      </p>
      <p v-if="removeStatus" class="remove-status">{{ removeStatus }}</p>
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

  .remove-status {
    margin: 10px 0 0;
    color: #ff8b8b;
    font-size: 0.76rem;
    line-height: 1.45;
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
