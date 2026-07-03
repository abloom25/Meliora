import type { Ref } from 'vue'
import type { Track } from '../types/music'
import { createTrackShareId, formatTrackDisplayTitle } from '../utils/tracks'
import type { HapticStyle } from './useHaptic'

export interface UseTrackShareOptions {
  currentTrack: Ref<Track | null>
  onTriggerHaptic: (style: HapticStyle) => void
  onShowNotice: (msg: string) => void
}

function copyText(value: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value)
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
  return Promise.resolve()
}

export function useTrackShare(options: UseTrackShareOptions) {
  const { currentTrack, onTriggerHaptic, onShowNotice } = options

  async function shareCurrentTrack() {
    const track = currentTrack.value
    if (!track) return
    onTriggerHaptic('light')

    const url = new URL(window.location.pathname, window.location.origin)
    url.searchParams.set('share', createTrackShareId(track))
    const shareTitle = `${formatTrackDisplayTitle(track)} - ${track.artist}`
    const shareText = `Meliora: ${shareTitle}`
    const shareData = {
      title: shareTitle,
      text: shareText,
      url: url.href,
    }
    const clipboardText = `${shareTitle}\n${url.href}`

    try {
      if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
        await navigator.share(shareData)
        return
      }
      await copyText(clipboardText)
      onTriggerHaptic('success')
      onShowNotice('歌曲分享信息已复制')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      try {
        await copyText(clipboardText)
        onTriggerHaptic('success')
        onShowNotice('歌曲分享信息已复制')
      } catch {
        onShowNotice('暂时无法分享这首歌曲')
      }
    }
  }

  return {
    shareCurrentTrack,
    copyText,
  }
}
