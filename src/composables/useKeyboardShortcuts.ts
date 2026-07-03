import { onMounted, onBeforeUnmount, type Ref } from 'vue'
import { isInteractiveElement } from '../utils/dom'

export function useKeyboardShortcuts({
  currentTime,
  duration,
  onToggle,
  onSeek,
  onNext,
  onPrevious,
  onToggleLyrics,
}: {
  currentTime: Ref<number>
  duration: Ref<number>
  onToggle: () => void
  onSeek: (time: number) => void
  onNext: () => void
  onPrevious: () => void
  onToggleLyrics: () => void
}) {
  function seekBy(delta: number) {
    const total = Number.isFinite(duration.value) && duration.value > 0 ? duration.value : Infinity
    const next = Math.min(Math.max(0, currentTime.value + delta), total)
    onSeek(next)
  }

  function handler(e: KeyboardEvent) {
    if (isInteractiveElement(e.target)) {
      return
    }

    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault()
      onToggle()
      return
    }

    if (e.code === 'ArrowLeft' && !e.shiftKey && !e.repeat) {
      e.preventDefault()
      seekBy(-5)
      return
    }

    if (e.code === 'ArrowRight' && !e.shiftKey && !e.repeat) {
      e.preventDefault()
      seekBy(5)
      return
    }

    if (e.code === 'ArrowLeft' && e.shiftKey && !e.repeat) {
      e.preventDefault()
      onPrevious()
      return
    }

    if (e.code === 'ArrowRight' && e.shiftKey && !e.repeat) {
      e.preventDefault()
      onNext()
      return
    }

    if (e.code === 'KeyL' && !e.repeat) {
      e.preventDefault()
      onToggleLyrics()
      return
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', handler)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', handler)
  })
}
