import type { AudioChannel } from '../../core/audio/backend'
import {
  CROSSFADE_DURATION_MS,
  crossfadeGains,
  fadeGain,
  fadeProgress,
} from '../../core/audio/fade'

/** 每个播放器独立持有增益动画及其浏览器帧资源。 */
export function createAudioGain() {
  // 按通道独立的动画标识:同一路上后启动的淡入淡出会取消前一个,
  // 但不同通道互不干扰 —— 旧曲目的淡出不会被新曲目的淡入取消,
  // 否则手动切歌时旧音频来不及衰减就会与新的叠着响。
  // 计数器从 1 起,0 表示"无动画/已取消"。
  const gainAnimations = new WeakMap<AudioChannel, number>()
  const gainAnimationFrames = new Set<number>()
  // 取消某一路正在进行的淡入淡出:把它的 animationId 归零,
  // 挂起的 rAF step 在下一帧自检时就会提前结束
  function cancelGainAnimation(channel: AudioChannel) {
    gainAnimations.set(channel, 0)
  }

  function clearGainAnimationFrames() {
    // 创建副本以避免在迭代过程中修改集合
    const framesToCancel = Array.from(gainAnimationFrames)
    for (const frame of framesToCancel) {
      try {
        window.cancelAnimationFrame(frame)
      } catch (error) {
        // 忽略无效的 frame ID，防止清理过程本身出错
        console.warn('Failed to cancel animation frame:', error)
      }
    }
    gainAnimationFrames.clear()
  }

  function requestGainAnimationFrame(callback: FrameRequestCallback) {
    const frame = window.requestAnimationFrame((now) => {
      gainAnimationFrames.delete(frame)
      callback(now)
    })
    gainAnimationFrames.add(frame)
  }

  // updaters 收到的是**原始进度**(0…1),缓动曲线由 core/audio/fade 施加,
  // 保证 Web 与桌面端的淡入淡出手感一致
  function animateGain(
    targets: AudioChannel[],
    updaters: Array<(progress: number) => void>,
    duration: number,
  ): Promise<void> {
    const animationId = Math.max(1, ...targets.map((c) => (gainAnimations.get(c) ?? 0) + 1))
    for (const c of targets) gainAnimations.set(c, animationId)
    const startedAt = performance.now()
    return new Promise<void>((resolve) => {
      function applyAll(progress: number) {
        for (const update of updaters) update(progress)
      }

      function step(now: number) {
        // 任一涉及通道被新动画接管即整体停止;0 表示被 cancelGainAnimation 显式取消。
        if (targets.some((c) => gainAnimations.get(c) !== animationId)) {
          resolve()
          return
        }
        const raw = fadeProgress(now - startedAt, duration)
        applyAll(raw)

        if (raw >= 1) {
          resolve()
          return
        }
        if (document.hidden) {
          applyAll(1)
          resolve()
          return
        }
        requestGainAnimationFrame(step)
      }

      if (document.hidden) {
        applyAll(1)
        resolve()
        return
      }
      requestGainAnimationFrame(step)
    })
  }

  function crossfadePlayers(outgoing: AudioChannel, incoming: AudioChannel) {
    return animateGain(
      [outgoing, incoming],
      [
        (progress) => outgoing.setGain(crossfadeGains(progress).outgoing),
        (progress) => incoming.setGain(crossfadeGains(progress).incoming),
      ],
      CROSSFADE_DURATION_MS,
    ).then(() => {
      outgoing.setGain(0)
      incoming.setGain(1)
    })
  }

  function fadePlayer(channel: AudioChannel, fromGain: number, toGain: number, duration: number) {
    return animateGain(
      [channel],
      [(progress) => channel.setGain(fadeGain(fromGain, toGain, progress))],
      duration,
    ).then(() => {
      channel.setGain(toGain)
    })
  }

  return { cancelGainAnimation, clearGainAnimationFrames, crossfadePlayers, fadePlayer }
}
