import type { Track } from '../../core/types'
import { MEDIA_SESSION_ACTIONS } from '../../../shared/constants'

/** 浏览器媒体控制适配器；播放和队列决策仍由播放器负责。 */
export function createMediaSession(options: {
  currentTrack: () => Track | null
  isPlaying: () => boolean
  currentTime: () => number
  play: () => Promise<void>
  pause: () => void
  previous: () => Promise<void>
  next: () => Promise<void>
  seek: (time: number) => void
}) {
  const { play, pause, previous, next, seek } = options
  function syncMediaSession() {
    if (!('mediaSession' in navigator)) return
    const track = options.currentTrack()
    if (!track) {
      try {
        navigator.mediaSession.metadata = null
        navigator.mediaSession.playbackState = 'none'
      } catch {
        // Safari 旧版本对 mediaSession 赋值可能抛错
      }
      return
    }
    // Safari 15-16 有 mediaSession 对象但无 MediaMetadata 构造函数,需先检测
    if (typeof MediaMetadata !== 'undefined') {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title,
          artist: track.artist,
          album: track.album || 'Meliora',
          artwork: track.cover ? [{ src: track.cover }] : [],
        })
      } catch {
        // 部分浏览器对 artwork 格式有要求,失败时忽略
      }
    }
    try {
      navigator.mediaSession.playbackState = options.isPlaying() ? 'playing' : 'paused'
    } catch {
      // Safari 旧版本对 playbackState 赋值可能抛错
    }
  }

  // Safari 15-16 对部分 MediaSessionAction 不支持,setActionHandler 会抛 TypeError,
  // 用统一包装函数兜底,避免初始化阶段整体失败。
  function safeSetActionHandler(
    action: MediaSessionAction,
    handler: MediaSessionActionHandler | null,
  ) {
    try {
      navigator.mediaSession.setActionHandler(action, handler)
    } catch {
      // 忽略不支持的动作
    }
  }

  if ('mediaSession' in navigator) {
    safeSetActionHandler('play', () => void play())
    safeSetActionHandler('pause', pause)
    safeSetActionHandler('previoustrack', () => void previous())
    safeSetActionHandler('nexttrack', () => void next())
    safeSetActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined) seek(details.seekTime)
    })
    safeSetActionHandler('seekbackward', (details) =>
      seek(options.currentTime() - (details.seekOffset || 10)),
    )
    safeSetActionHandler('seekforward', (details) =>
      seek(options.currentTime() + (details.seekOffset || 10)),
    )
  }

  function syncPosition(position: number, duration: number | null) {
    if (!('mediaSession' in navigator) || duration === null) return
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: 1,
        position: Math.min(position, duration),
      })
    } catch {
      // 切歌过程中浏览器可能拒绝位置更新。
    }
  }
  function dispose() {
    if (!('mediaSession' in navigator)) return
    for (const action of MEDIA_SESSION_ACTIONS) safeSetActionHandler(action, null)
  }
  return { sync: syncMediaSession, syncPosition, dispose }
}
