import { onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import { createLyricShareCardRenderer } from './lyric-share-card'
import type { LyricLine, Track } from '../../core/types'

export interface LyricShareCardInput {
  track: Track
  lines: readonly LyricLine[]
  includeTranslation: boolean
  timeLabel?: string
}

export function useLyricShareCard(input: Ref<LyricShareCardInput | null>) {
  const previewUrl = ref('')
  const loading = ref(false)
  const error = ref('')
  const file = shallowRef<File | null>(null)
  let controller: AbortController | null = null
  let generation = 0
  let renderTimer: ReturnType<typeof setTimeout> | undefined
  const renderer = createLyricShareCardRenderer()

  function releasePreview() {
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = ''
    file.value = null
  }

  async function generate(retryCover = false) {
    clearTimeout(renderTimer)
    renderTimer = undefined
    const id = ++generation
    controller?.abort()
    controller = null
    error.value = ''
    file.value = null
    const value = input.value
    if (!value || !value.lines.length) {
      loading.value = false
      releasePreview()
      renderer.clear()
      return
    }
    const request = new AbortController()
    controller = request
    loading.value = true
    try {
      const blob = await renderer.render(value, request.signal, { retryCover })
      if (request.signal.aborted || id !== generation) return
      const filename = `${value.track.title.replace(/[<>:"/\\|?*\p{Cc}]/gu, '').slice(0, 70) || 'Meliora'}-歌词.png`
      const nextFile = new File([blob], filename, { type: 'image/png' })
      const nextUrl = URL.createObjectURL(blob)
      releasePreview()
      file.value = nextFile
      previewUrl.value = nextUrl
    } catch (reason) {
      if (request.signal.aborted || id !== generation) return
      releasePreview()
      error.value = reason instanceof Error ? reason.message : '卡片生成失败，请重试'
    } finally {
      if (id === generation) loading.value = false
    }
  }

  watch(
    input,
    (value, previous) => {
      clearTimeout(renderTimer)
      renderTimer = undefined
      controller?.abort()
      generation += 1
      // Disable exporting immediately while leaving the last preview in place.
      file.value = null
      error.value = ''
      if (!value?.lines.length || !previous) {
        void generate()
        return
      }
      loading.value = true
      renderTimer = setTimeout(() => void generate(), 120)
    },
    { immediate: true, flush: 'sync' },
  )
  onScopeDispose(() => {
    generation += 1
    controller?.abort()
    clearTimeout(renderTimer)
    renderer.clear()
    releasePreview()
  })

  return { previewUrl, loading, error, file, retry: () => generate(true) }
}

export function canShareLyricImage(file: File): boolean {
  try {
    return typeof navigator.share === 'function' && Boolean(navigator.canShare?.({ files: [file] }))
  } catch {
    return false
  }
}

export async function copyLyricImage(file: File): Promise<void> {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    throw new Error('复制图片需要 HTTPS 或 localhost，请使用下载图片。')
  }
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.clipboard?.write !== 'function' ||
    typeof ClipboardItem === 'undefined' ||
    (typeof ClipboardItem.supports === 'function' && !ClipboardItem.supports('image/png'))
  ) {
    throw new Error('当前浏览器不支持复制图片，请使用下载图片。')
  }
  if (file.type !== 'image/png') throw new Error('图片尚未准备好，请重试。')
  try {
    // The PNG is already rendered. Write within the click's user activation,
    // without fetching or re-encoding first (required by Safari).
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': file })])
  } catch (reason) {
    if (
      reason instanceof DOMException &&
      (reason.name === 'NotAllowedError' || reason.name === 'SecurityError')
    ) {
      throw new Error('复制图片未获授权，请允许剪贴板访问后重试，或下载图片。', { cause: reason })
    }
    throw new Error('图片复制失败，请重试或下载图片。', { cause: reason })
  }
}

export function downloadLyricImage(file: File): void {
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  document.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    // Download handlers can consume the object URL after the click has returned.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }
}
