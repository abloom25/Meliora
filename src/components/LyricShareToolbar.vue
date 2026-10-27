<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
  import { Check, ChevronLeft, Copy, Download, Image, Share2, X } from '@lucide/vue'
  import {
    lyricShareTime,
    lyricShareTimeLabel,
    selectedShareLines,
    type LyricShareSelection,
  } from '../core/lyrics/share'
  import {
    canShareLyricImage,
    copyLyricImage,
    downloadLyricImage,
    useLyricShareCard,
  } from '../platform/web/useLyricShareCard'

  const props = defineProps<{
    visible: boolean
    selection: LyricShareSelection
    indices: number[]
  }>()
  const emit = defineEmits<{ close: []; preview: [open: boolean] }>()
  const includeTranslation = ref(true)
  const previewOpen = ref(false)
  const previewLeaving = ref(false)
  const previewExpanded = computed(() => previewOpen.value || previewLeaving.value)
  const previewScroll = ref<HTMLElement | null>(null)
  const previewButton = ref<HTMLButtonElement | null>(null)
  const notice = ref('')
  const sharing = ref(false)
  const copying = ref(false)
  let revision = 0
  const selectedLines = computed(() => selectedShareLines(props.selection.lines, props.indices))
  const hasTranslation = computed(() => selectedLines.value.some((line) => line.translation))
  const time = computed(() => lyricShareTime(selectedLines.value))
  const cardInput = computed(() =>
    props.visible
      ? {
          track: props.selection.track,
          lines: selectedLines.value,
          includeTranslation: includeTranslation.value,
          timeLabel: lyricShareTimeLabel(time.value),
        }
      : null,
  )
  const { previewUrl, loading, error, file, retry } = useLyricShareCard(cardInput)
  const nativeShare = computed(() => Boolean(file.value && canShareLyricImage(file.value)))
  const actionDisabled = computed(
    () =>
      !props.visible ||
      !selectedLines.value.length ||
      !file.value ||
      loading.value ||
      sharing.value ||
      copying.value,
  )

  function setPreview(open: boolean): void {
    if (!props.visible || open === previewOpen.value) return
    previewLeaving.value = !open
    previewOpen.value = open
    if (open)
      void nextTick(() => {
        if (props.visible && previewOpen.value) previewScroll.value?.focus({ preventScroll: true })
      })
  }

  function finishPreviewLeave(): void {
    if (previewOpen.value) return
    previewLeaving.value = false
    if (props.visible) previewButton.value?.focus({ preventScroll: true })
  }

  function handleEscape(): void {
    if (previewOpen.value) setPreview(false)
    else if (!previewLeaving.value) emit('close')
  }

  watch(previewExpanded, (open) => emit('preview', open))

  function downloadImage(): void {
    const image = file.value
    if (actionDisabled.value || !image) return
    try {
      downloadLyricImage(image)
      notice.value = '图片已开始下载'
    } catch {
      notice.value = '图片下载失败，请重试'
    }
  }

  async function copyImage(): Promise<void> {
    const image = file.value
    if (actionDisabled.value || !image) return
    const request = revision
    const selection = cardInput.value
    copying.value = true
    notice.value = ''
    try {
      await copyLyricImage(image)
      if (request === revision && props.visible && selection === cardInput.value)
        notice.value = '图片已复制，可直接粘贴'
    } catch (reason) {
      if (request === revision && props.visible && selection === cardInput.value)
        notice.value = reason instanceof Error ? reason.message : '图片复制失败，请重试或下载图片'
    } finally {
      if (request === revision) copying.value = false
    }
  }

  async function shareImage(): Promise<void> {
    const image = file.value
    if (actionDisabled.value || !image || !canShareLyricImage(image)) return
    const request = revision
    const selection = cardInput.value
    sharing.value = true
    notice.value = ''
    try {
      await navigator.share({ files: [image] })
    } catch (reason) {
      if (request !== revision || !props.visible || selection !== cardInput.value) return
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      notice.value = '分享未完成，可以复制或下载图片'
    } finally {
      if (request === revision) sharing.value = false
    }
  }

  watch(
    () => props.visible,
    (visible) => {
      revision += 1
      sharing.value = false
      copying.value = false
      if (!visible) {
        previewOpen.value = false
        previewLeaving.value = false
      }
    },
  )
  watch(cardInput, () => {
    notice.value = ''
  })
  onBeforeUnmount(() => {
    revision += 1
  })
</script>

<template>
  <div
    class="lyric-share-tools"
    :class="{ 'preview-expanded': previewExpanded }"
    :inert="visible ? undefined : true"
    role="region"
    aria-label="歌词分享操作"
    @keydown.esc.stop.prevent="handleEscape"
  >
    <Transition
      name="share-preview"
      @after-leave="finishPreviewLeave"
      @before-leave="(element) => element.setAttribute('inert', '')"
    >
      <section v-if="previewOpen" class="share-preview" aria-label="歌词卡片">
        <header class="preview-header">
          <button
            type="button"
            class="preview-back"
            title="返回选句（Esc）"
            @click="setPreview(false)"
          >
            <ChevronLeft :size="18" />
            <span>返回选句</span>
          </button>
          <button
            v-if="hasTranslation"
            class="translation-action"
            type="button"
            aria-label="分享卡片包含译文"
            title="包含译文"
            :aria-pressed="includeTranslation"
            @click="includeTranslation = !includeTranslation"
          >
            <Check :size="14" :class="{ unchecked: !includeTranslation }" />
            <span>译文</span>
          </button>
        </header>
        <div
          ref="previewScroll"
          class="preview-scroll"
          role="region"
          aria-label="歌词卡片预览，可滚动查看"
          :aria-busy="loading"
          tabindex="0"
        >
          <div class="preview-content">
            <Transition name="card-swap" mode="out-in">
              <img
                v-if="previewUrl"
                :key="previewUrl"
                :src="previewUrl"
                alt="所选歌词卡片预览"
                :class="{ updating: loading }"
                draggable="false"
              />
              <div
                v-else-if="loading"
                key="loading"
                class="preview-skeleton"
                aria-label="正在生成卡片"
                role="status"
              >
                <span /><span /><span />
              </div>
              <p v-else key="empty">
                {{ error || '点选想分享的歌词'
                }}<button v-if="error" type="button" @click="retry">重试</button>
              </p>
            </Transition>
          </div>
        </div>
      </section>
    </Transition>
    <footer class="share-footer">
      <div class="share-action-row">
        <span class="selection-count" aria-live="polite"
          >{{ indices.length }}<small> / 6</small></span
        >
        <button
          ref="previewButton"
          type="button"
          aria-label="预览歌词卡片"
          title="预览卡片"
          :aria-expanded="previewOpen"
          :class="{ active: previewOpen }"
          @click="setPreview(!previewOpen)"
        >
          <Image :size="18" />
        </button>
        <span class="action-spacer" />
        <button
          class="image-action copy-action"
          type="button"
          aria-label="复制图片"
          title="复制图片"
          :disabled="actionDisabled"
          :aria-busy="copying"
          :class="{ generating: copying }"
          @click="copyImage"
        >
          <Copy :size="17" />
          <span class="action-label">复制图片</span>
        </button>
        <button
          class="image-action download-action"
          type="button"
          aria-label="下载图片"
          title="下载图片"
          :disabled="actionDisabled"
          :class="{ generating: loading }"
          @click="downloadImage"
        >
          <Download :size="17" />
          <span class="action-label">下载图片</span>
        </button>
        <button
          v-if="nativeShare"
          class="share-action"
          type="button"
          aria-label="分享图片"
          title="分享图片"
          :disabled="actionDisabled"
          :aria-busy="sharing"
          @click="shareImage"
        >
          <Share2 :size="17" />
        </button>
        <button
          type="button"
          aria-label="结束歌词选择"
          title="完成选择（Esc）"
          @click="emit('close')"
        >
          <X :size="19" />
        </button>
      </div>
      <p class="share-notice" role="status">
        {{
          notice ||
          error ||
          (previewExpanded
            ? '分享所选歌词，或返回继续选句'
            : indices.length
              ? '点选歌词，最多 6 句'
              : '点选想分享的歌词')
        }}<button v-if="error && !previewOpen" type="button" @click="retry">重试</button>
      </p>
    </footer>
  </div>
</template>

<style scoped lang="scss">
  .lyric-share-tools {
    grid-column: 1;
    grid-row: 2;
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    color: var(--text);
  }
  .lyric-share-tools.preview-expanded {
    grid-row: 1 / -1;
    height: 100%;
    z-index: 1;
  }
  .share-footer {
    container-type: inline-size;
    grid-row: 2;
    min-width: 0;
    padding: 8px 4px 4px;
  }
  .share-action-row {
    display: flex;
    align-items: center;
    gap: clamp(0px, 0.5vw, 6px);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .preview-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 4px 8px;
  }
  .preview-header button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 1 auto;
    gap: 6px;
    padding-inline: 10px;
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .translation-action .unchecked {
    opacity: 0;
  }
  button {
    display: inline-grid;
    place-items: center;
    flex: 0 0 44px;
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    border: 0;
    border-radius: 14px;
    corner-shape: squircle;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.9rem;
    cursor: pointer;
    transition:
      color 220ms cubic-bezier(0.16, 1, 0.3, 1),
      background 220ms cubic-bezier(0.16, 1, 0.3, 1),
      transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  button:hover:not(:disabled),
  button.active,
  button[aria-pressed='true'] {
    color: var(--text);
    background: rgba(255, 255, 255, 0.07);
  }
  button:active:not(:disabled) {
    transform: scale(0.94);
  }
  button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  button:focus-visible {
    outline: 2px solid var(--text-muted);
    outline-offset: -2px;
  }
  .selection-count {
    flex: 0 0 auto;
    padding-inline: 8px;
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
  }
  .selection-count small {
    font-size: 0.65rem;
    color: var(--text-subtle);
  }
  .action-spacer {
    flex: 1;
  }
  .image-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-basis: auto;
    gap: 7px;
    padding-inline: 12px;
    font-size: 0.75rem;
    white-space: nowrap;
    color: var(--text);
  }
  @container (max-width: 420px) {
    .share-action-row {
      gap: 2px;
    }
    .image-action {
      flex-basis: 44px;
      padding-inline: 0;
    }
    .action-label {
      display: none;
    }
  }
  .share-notice {
    margin: 2px 8px 0;
    min-height: 1.5em;
    color: var(--text-subtle);
    font-size: 0.66rem;
    line-height: 1.5;
  }
  .share-notice button {
    margin-left: 8px;
    font-size: inherit;
  }
  .share-preview {
    grid-area: 1 / 1;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .preview-scroll {
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    touch-action: pan-y;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
    scrollbar-gutter: stable both-edges;
    border-radius: 20px;
    corner-shape: squircle;
  }
  .preview-scroll:focus-visible {
    outline: 1px solid var(--text-subtle);
    outline-offset: -1px;
  }
  .preview-content {
    display: grid;
    justify-items: center;
    align-content: start;
    min-height: 100%;
    padding: 4px 8px 12px;
  }
  .share-preview img {
    display: block;
    width: min(100%, 560px);
    height: auto;
    border-radius: 20px;
    corner-shape: squircle;
    transition: opacity 240ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .share-preview img.updating {
    opacity: 0.45;
  }
  .share-preview p {
    color: var(--text-muted);
    font-size: 0.75rem;
  }
  .preview-skeleton {
    display: grid;
    align-content: center;
    gap: 10px;
    padding: 10%;
    width: min(100%, 560px);
    aspect-ratio: 4 / 3;
    border-radius: 20px;
    corner-shape: squircle;
    background: rgba(255, 255, 255, 0.04);
  }
  .preview-skeleton span {
    height: 10px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.12);
    animation: share-breathe 1s ease-in-out infinite alternate;
  }
  .preview-skeleton span:last-child {
    width: 60%;
  }
  .generating svg {
    animation: share-breathe 1s ease-in-out infinite alternate;
  }
  .card-swap-enter-active,
  .card-swap-leave-active,
  .share-preview-enter-active,
  .share-preview-leave-active {
    transition:
      opacity 200ms cubic-bezier(0.16, 1, 0.3, 1),
      filter 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .card-swap-enter-from,
  .card-swap-leave-to,
  .share-preview-enter-from,
  .share-preview-leave-to {
    opacity: 0;
    filter: blur(4px);
  }
  @keyframes share-breathe {
    to {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      transition: none !important;
      animation: none !important;
    }
  }
  @media (prefers-contrast: more) {
    .share-notice,
    .selection-count small {
      color: var(--text-muted);
    }
  }
</style>
