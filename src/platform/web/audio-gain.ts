import type { AudioChannel } from '../../core/audio/backend'
import {
  CROSSFADE_DURATION_MS,
  crossfadeGains,
  fadeGain,
  fadeProgress,
} from '../../core/audio/fade'

/** 增益动画独占通道。取消会结束 Promise，但绝不提交旧动画的最终音量。 */
export function createAudioGain() {
  const owners = new Map<AudioChannel, (completed: boolean) => void>()

  function cancelGainAnimation(channel: AudioChannel): void {
    owners.get(channel)?.(false)
  }

  function clearGainAnimationFrames(): void {
    for (const finish of new Set(owners.values())) finish(false)
  }

  function animateGain(
    targets: AudioChannel[],
    update: (progress: number) => void,
    duration: number,
  ): Promise<boolean> {
    for (const channel of targets) cancelGainAnimation(channel)
    return new Promise<boolean>((resolve) => {
      let frame = 0
      let settled = false
      const startedAt = performance.now()
      function finish(completed: boolean): void {
        if (settled) return
        settled = true
        window.cancelAnimationFrame(frame)
        document.removeEventListener('visibilitychange', onVisibilityChange)
        if (completed) update(1)
        for (const channel of targets) {
          if (owners.get(channel) === finish) owners.delete(channel)
        }
        resolve(completed)
      }
      function onVisibilityChange(): void {
        if (document.hidden) finish(true)
      }
      function step(now: number): void {
        if (settled) return
        const progress = fadeProgress(now - startedAt, duration)
        if (progress >= 1 || document.hidden) return finish(true)
        update(progress)
        frame = window.requestAnimationFrame(step)
      }
      for (const channel of targets) owners.set(channel, finish)
      if (document.hidden) finish(true)
      else {
        document.addEventListener('visibilitychange', onVisibilityChange)
        frame = window.requestAnimationFrame(step)
      }
    })
  }

  function crossfadePlayers(outgoing: AudioChannel, incoming: AudioChannel): Promise<boolean> {
    return animateGain(
      [outgoing, incoming],
      (progress) => {
        const gains = crossfadeGains(progress)
        outgoing.setGain(gains.outgoing)
        incoming.setGain(gains.incoming)
      },
      CROSSFADE_DURATION_MS,
    )
  }

  function fadePlayer(
    channel: AudioChannel,
    fromGain: number,
    toGain: number,
    duration: number,
  ): Promise<boolean> {
    return animateGain(
      [channel],
      (progress) => channel.setGain(fadeGain(fromGain, toGain, progress)),
      duration,
    )
  }

  return { cancelGainAnimation, clearGainAnimationFrames, crossfadePlayers, fadePlayer }
}
