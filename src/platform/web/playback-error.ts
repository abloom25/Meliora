// 把浏览器的播放错误归一成核心层认识的 PlaybackFailureReason。
//
// 信息来自两处:play() 拒绝时的 DOMException.name,以及元素上的 MediaError.code。
// 桌面端换成原生后端时,这个文件不复用 —— 那边有自己的错误码,映射到同一组 reason 即可。

import type { PlaybackFailureReason } from '../../core/audio/failure'

const MEDIA_ERR_NETWORK = 2
const MEDIA_ERR_DECODE = 3
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

export function classifyPlaybackError(
  error: unknown,
  audio: HTMLAudioElement,
): PlaybackFailureReason {
  const reason = error as DOMException | undefined
  if (reason?.name === 'AbortError') return 'aborted'
  if (reason?.name === 'NotAllowedError') return 'not-allowed'

  if (!audio.currentSrc && !audio.src) return 'missing-source'
  switch (audio.error?.code) {
    case MEDIA_ERR_NETWORK:
      return 'network'
    case MEDIA_ERR_DECODE:
      return 'decode'
    case MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'unsupported'
  }
  if (reason?.name === 'NotSupportedError') return 'unsupported'
  return 'unknown'
}
