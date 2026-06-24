<script setup lang="ts">
  import { ref } from 'vue'
  import { Plus, Trash2, Pencil, Check, X, ChevronDown } from '@lucide/vue'
  import type { MetingPlaylistConfig, MusicServer } from '../../types/music'
  import ToggleSwitch from '../../components/ToggleSwitch.vue'
  import Dropdown from '../../components/Dropdown.vue'
  import ConfirmModal from './ConfirmModal.vue'
  import BaseInput from '../../components/BaseInput.vue'

  const props = defineProps<{ playlists: MetingPlaylistConfig[] }>()
  const emit = defineEmits<{ 'update:playlists': [value: MetingPlaylistConfig[]] }>()

  const editingIndex = ref<number | null>(null)
  const pendingRemoveIndex = ref<number | null>(null)

  const serverOptions: { value: MusicServer; label: string; color: string }[] = [
    { value: 'netease', label: '网易云', color: '#ff6b6b' },
    { value: 'tencent', label: 'QQ 音乐', color: '#ffb060' },
  ]

  function serverLabel(value: string): string {
    return serverOptions.find((o) => o.value === value)?.label || value
  }

  function update(index: number, patch: Partial<MetingPlaylistConfig>) {
    const next = props.playlists.map((item, i) => (i === index ? { ...item, ...patch } : item))
    emit('update:playlists', next)
  }

  function add() {
    emit('update:playlists', [
      ...props.playlists,
      { server: 'netease', playlistId: '', enabled: true },
    ])
    editingIndex.value = props.playlists.length
  }

  function remove(index: number) {
    emit(
      'update:playlists',
      props.playlists.filter((_, i) => i !== index),
    )
    if (editingIndex.value === index) editingIndex.value = null
    if (editingIndex.value !== null && editingIndex.value > index) {
      editingIndex.value -= 1
    }
  }

  function requestRemove(index: number) {
    pendingRemoveIndex.value = index
  }

  function confirmRemove() {
    if (pendingRemoveIndex.value === null) return
    remove(pendingRemoveIndex.value)
    pendingRemoveIndex.value = null
  }

  function cancelRemove() {
    pendingRemoveIndex.value = null
  }

  function startEdit(index: number) {
    editingIndex.value = index
  }

  function cancelEdit(index: number) {
    editingIndex.value = null
    if (!props.playlists[index]?.playlistId.trim()) {
      remove(index)
    }
  }

  function saveEdit(index: number) {
    if (!props.playlists[index]?.playlistId.trim()) return
    editingIndex.value = null
  }

  function selectServer(server: MusicServer) {
    if (editingIndex.value !== null) {
      update(editingIndex.value, { server })
    }
  }

  function selectServerAndClose(server: MusicServer, close: () => void) {
    selectServer(server)
    close()
  }
</script>

<template>
  <div class="playlist-editor">
    <Transition name="fade">
      <div v-if="!playlists.length" class="empty">暂无远程歌单,点击下方添加</div>
    </Transition>

    <TransitionGroup name="list" tag="div" class="playlist-list">
      <div
        v-for="(playlist, index) in playlists"
        :key="`pl-${index}-${playlist.server}`"
        class="playlist-row"
        :class="{ disabled: playlist.enabled === false, editing: editingIndex === index }"
      >
        <template v-if="editingIndex === index">
          <div class="edit-form">
            <Dropdown>
              <template #trigger="{ toggle }">
                <button type="button" class="dropdown-trigger" @click="toggle">
                  <span class="dropdown-tag" :class="playlist.server">
                    {{ serverLabel(playlist.server) }}
                  </span>
                  <ChevronDown :size="15" class="dropdown-chevron" />
                </button>
              </template>
              <template #default="{ close }">
                <button
                  v-for="opt in serverOptions"
                  :key="opt.value"
                  type="button"
                  class="dropdown-item"
                  :class="{ active: playlist.server === opt.value }"
                  @click="selectServerAndClose(opt.value, close)"
                >
                  <span class="dropdown-dot" :style="{ background: opt.color }" />
                  {{ opt.label }}
                </button>
              </template>
            </Dropdown>

            <div class="id-field">
              <BaseInput
                :model-value="playlist.playlistId"
                :class="{ invalid: !playlist.playlistId.trim() }"
                type="text"
                placeholder="歌单 ID"
                @update:model-value="update(index, { playlistId: $event })"
              />
              <small v-if="!playlist.playlistId.trim()" class="field-error">歌单 ID 不能为空</small>
            </div>

            <div class="edit-actions">
              <button
                type="button"
                class="icon-btn confirm"
                :class="{ disabled: !playlist.playlistId.trim() }"
                title="保存"
                @click="saveEdit(index)"
              >
                <Check :size="16" />
              </button>
              <button type="button" class="icon-btn cancel" title="取消" @click="cancelEdit(index)">
                <X :size="16" />
              </button>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="playlist-info">
            <span class="server-tag" :class="playlist.server">
              {{ serverLabel(playlist.server) }}
            </span>
            <span class="playlist-id">{{ playlist.playlistId || '未设置' }}</span>
          </div>

          <div class="row-actions">
            <ToggleSwitch
              :model-value="playlist.enabled !== false"
              :title="playlist.enabled === false ? '已禁用' : '已启用'"
              @update:model-value="update(index, { enabled: $event })"
            />

            <button type="button" class="icon-btn" title="修改" @click="startEdit(index)">
              <Pencil :size="15" />
            </button>
            <button
              type="button"
              class="icon-btn danger"
              title="删除"
              @click="requestRemove(index)"
            >
              <Trash2 :size="15" />
            </button>
          </div>
        </template>
      </div>
    </TransitionGroup>

    <button class="add-button" type="button" @click="add">
      <Plus :size="15" />
      <span>添加歌单</span>
    </button>

    <ConfirmModal
      :visible="pendingRemoveIndex !== null"
      title="删除这个歌单?"
      cancel-text="取消"
      confirm-text="确认删除"
      danger
      @cancel="cancelRemove"
      @confirm="confirmRemove"
    >
      <p>
        将从配置中移除
        <strong>
          {{ serverLabel(playlists[pendingRemoveIndex ?? 0]?.server || '') }}
          {{ playlists[pendingRemoveIndex ?? 0]?.playlistId || '未设置 ID' }}
        </strong>
        。保存前仍可通过右下角撤销恢复。
      </p>
    </ConfirmModal>
  </div>
</template>

<style scoped lang="scss">
  .playlist-editor {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 0 14px;
  }

  .playlist-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .empty {
    color: var(--text-subtle);
    font-size: 0.8rem;
    padding: 10px 0;
  }

  .playlist-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    background: rgba(0, 0, 0, 0.18);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    position: relative;

    &.disabled {
      opacity: 0.45;
    }

    &.editing {
      background: color-mix(in srgb, var(--accent), transparent 94%);
      border-color: color-mix(in srgb, var(--accent), transparent 75%);
      z-index: 30;
    }
  }

  .playlist-info {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1;
  }

  .server-tag {
    flex-shrink: 0;
    padding: 3px 9px;
    border-radius: 8px;
    font-size: 0.7rem;
    font-weight: 620;

    &.netease {
      background: rgba(238, 64, 64, 0.18);
      color: #ff6b6b;
    }

    &.tencent {
      background: rgba(255, 149, 0, 0.18);
      color: #ffb060;
    }
  }

  .playlist-id {
    color: rgba(255, 255, 255, 0.85);
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    background: transparent;
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      background: rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.9);
    }

    &.confirm {
      border-color: color-mix(in srgb, var(--accent), transparent 60%);
      color: var(--accent);

      &:hover {
        background: color-mix(in srgb, var(--accent), transparent 88%);
      }

      &.disabled {
        opacity: 0.35;
        pointer-events: none;
      }
    }

    &.cancel:hover {
      background: rgba(255, 139, 139, 0.1);
      color: #ff8b8b;
    }

    &.danger {
      border-color: rgba(255, 139, 139, 0.25);

      &:hover {
        background: rgba(255, 139, 139, 0.12);
        color: #ff8b8b;
      }
    }
  }

  .edit-form {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
  }

  .dropdown-trigger {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.25);
    color: rgba(255, 255, 255, 0.85);
    font-size: 0.78rem;
    cursor: pointer;
    transition: border-color 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      border-color: rgba(255, 255, 255, 0.25);
    }
  }

  .dropdown-tag {
    padding: 2px 7px;
    border-radius: 6px;
    font-size: 0.7rem;
    font-weight: 620;

    &.netease {
      background: rgba(238, 64, 64, 0.18);
      color: #ff6b6b;
    }

    &.tencent {
      background: rgba(255, 149, 0, 0.18);
      color: #ffb060;
    }
  }

  .dropdown-chevron {
    color: rgba(255, 255, 255, 0.4);
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: rgba(255, 255, 255, 0.75);
    font-size: 0.78rem;
    cursor: pointer;
    transition: background 0.15s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    &.active {
      background: color-mix(in srgb, var(--accent), transparent 88%);
      color: var(--accent);
    }
  }

  .dropdown-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .id-field {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  :deep(.base-input.invalid) {
    border-color: #ff5a5a;

    &:focus {
      border-color: #ff7a7a;
    }
  }

  .field-error {
    color: #ff6b6b;
    font-size: 0.68rem;
    padding-left: 2px;
  }

  .edit-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
    padding-top: 2px;
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
    transition:
      background 0.2s cubic-bezier(0.16, 1, 0.3, 1),
      border-color 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.3);
    }
  }

  .list-enter-active {
    transition:
      opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1),
      transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .list-leave-active {
    transition:
      opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1),
      transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    position: absolute;
    width: calc(100% - 28px);
  }

  .list-enter-from {
    opacity: 0;
    transform: translateY(-8px) scale(0.98);
  }

  .list-leave-to {
    opacity: 0;
    transform: scale(0.95);
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
</style>
