// Web 端的播放后端:三个 <audio> 元素,一路出声、两路预加载。
//
// 上层拿到的是**通道句柄**,不是元素。句柄背后的元素可以被换掉而句柄不变 ——
// 跨源音频接进 Web Audio 会被污染,只能丢掉 crossOrigin 重建元素(牺牲频谱保播放),
// 这件事完全发生在本文件内部:换元素、迁移播放位置、重新挂监听,上层什么都不用做。
//
// 频谱分析要的是真实元素,所以额外暴露一个 Web 专有出口 elementOf(),
// 只给 useBeatAnalyser 用;编排层不该碰它。

import type { AudioBackend, AudioChannel, AudioChannelEvent } from '../../core/audio/backend'
import type { PlaybackFailureReason } from '../../core/audio/failure'
import { classifyPlaybackError } from './playback-error'

const CHANNEL_EVENTS: readonly AudioChannelEvent[] = [
  'timeupdate',
  'durationchange',
  'loadedmetadata',
  'canplay',
  'loadeddata',
  'play',
  'pause',
  'ended',
  'error',
]

export interface WebAudioBackendOptions {
  /** iOS 后台安全模式:出声元素必须挂进文档,且只能有一路出声 */
  backgroundSafe: boolean
  getMasterVolume: () => number
  /** 频谱降级时通知上层(队列小频谱要回退成序号) */
  onSpectrumLost?: () => void
}

export interface WebAudioBackend extends AudioBackend {
  /** Web 专有:取通道背后的真实元素,只给频谱分析用 */
  elementOf(channel: AudioChannel): HTMLAudioElement
  /** 跨源污染:换成无 crossOrigin 的元素,牺牲频谱保播放 */
  degradeForTaint(element: HTMLAudioElement): void
}

function createElement(
  preload: HTMLMediaElement['preload'],
  crossOrigin: 'anonymous' | undefined,
): HTMLAudioElement {
  const audio = new Audio()
  audio.preload = preload
  audio.setAttribute('playsinline', '')
  audio.setAttribute('webkit-playsinline', '')
  if (crossOrigin) audio.crossOrigin = crossOrigin
  return audio
}

interface ChannelInternals {
  channel: AudioChannel
  element(): HTMLAudioElement
  swapElement(next: HTMLAudioElement): void
}

function createChannel(
  id: string,
  initial: HTMLAudioElement,
  getMasterVolume: () => number,
): ChannelInternals {
  let element = initial
  // 这一路的淡入淡出增益。单独记而不是从 element.volume 反推:
  // 总音量为 0 时反推不出来,而增益必须在总音量变化后仍然成立
  let channelGain = 1
  const listeners = new Map<AudioChannelEvent, Set<() => void>>()
  // 挂在元素上的转发器。换元素时要先摘干净再挂到新元素上
  let forwarders: Array<{ type: string; handler: EventListener }> = []
  // 时长未知时 <audio> 写 currentTime 不生效,先记下来等 metadata 就绪再落位
  let pendingSeek: number | null = null

  function emit(event: AudioChannelEvent) {
    for (const listener of listeners.get(event) ?? []) listener()
  }

  function applyGain() {
    const volume = getMasterVolume() * channelGain
    element.volume = volume <= 0 ? 0 : volume >= 1 ? 1 : volume
  }

  function flushPendingSeek() {
    if (pendingSeek === null) return
    const total = element.duration
    if (!Number.isFinite(total) || total <= 0) return
    element.currentTime = Math.max(0, Math.min(pendingSeek, total))
    pendingSeek = null
  }

  function attach(target: HTMLAudioElement) {
    for (const event of CHANNEL_EVENTS) {
      const handler: EventListener = () => {
        // 时长一就绪就把欠着的跳转落位,再把事件转出去
        if (event === 'durationchange' || event === 'loadedmetadata') flushPendingSeek()
        emit(event)
      }
      target.addEventListener(event, handler)
      forwarders.push({ type: event, handler })
    }
  }

  function detach(target: HTMLAudioElement) {
    for (const { type, handler } of forwarders) target.removeEventListener(type, handler)
    forwarders = []
  }

  attach(element)

  const channel: AudioChannel = {
    id,
    load(url) {
      pendingSeek = null
      element.src = url
      element.load()
    },
    source() {
      return element.currentSrc || element.src || ''
    },
    release() {
      pendingSeek = null
      element.pause()
      element.removeAttribute('src')
      // load() 会中止正在进行的下载,不做的话慢响应的连接会一直占着带宽
      element.load()
    },
    play() {
      return element.play()
    },
    pause() {
      element.pause()
    },
    currentTime() {
      return element.currentTime
    },
    seek(seconds) {
      const total = element.duration
      if (!Number.isFinite(total) || total <= 0) {
        pendingSeek = seconds
        return
      }
      element.currentTime = Math.max(0, Math.min(seconds, total))
      pendingSeek = null
    },
    duration() {
      return Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null
    },
    setGain(gain) {
      channelGain = gain <= 0 ? 0 : gain >= 1 ? 1 : gain
      applyGain()
    },
    gain() {
      return channelGain
    },
    canStart() {
      return element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !element.error
    },
    failed() {
      return Boolean(element.error)
    },
    ended() {
      return element.ended
    },
    classifyFailure(error): PlaybackFailureReason {
      return classifyPlaybackError(error, element)
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
  }

  return {
    channel,
    element: () => element,
    swapElement(next) {
      const previous = element
      const wasPlaying = !previous.paused
      const position = previous.currentTime
      detach(previous)
      element = next
      attach(next)
      applyGain()
      // 新元素要接着放:等 metadata 就绪后回到原位置再继续,免得降级后进度回到 0
      const resume = () => {
        next.removeEventListener('loadedmetadata', resume)
        if (Number.isFinite(position) && position > 0) {
          try {
            next.currentTime = position
          } catch {
            // 少数浏览器在 metadata 刚就绪时仍会拒绝 seek,忽略即可
          }
        }
        if (wasPlaying) void next.play().catch(() => undefined)
      }
      next.addEventListener('loadedmetadata', resume)
      const source = previous.currentSrc || previous.src
      if (source) {
        next.src = source
        next.load()
      }
      // 旧元素收尾:不摘干净会与新元素同时出声
      previous.pause()
      previous.removeAttribute('src')
      previous.load()
    },
  }
}

export function createWebAudioBackend(options: WebAudioBackendOptions): WebAudioBackend {
  // 第一路出声,后两路预加载
  const internals = [
    createChannel('main', createElement('metadata', 'anonymous'), options.getMasterVolume),
    createChannel('spare-a', createElement('auto', 'anonymous'), options.getMasterVolume),
    createChannel('spare-b', createElement('auto', 'anonymous'), options.getMasterVolume),
  ]
  const byChannel = new Map(internals.map((entry) => [entry.channel, entry]))
  let active = internals[0]!.channel
  let host: HTMLDivElement | null = null
  let spectrumAvailable = !options.backgroundSafe

  function ensureHost(): HTMLDivElement | null {
    if (!options.backgroundSafe || typeof document === 'undefined') return null
    if (host?.isConnected) return host
    host = document.createElement('div')
    host.setAttribute('aria-hidden', 'true')
    host.style.cssText =
      'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-9999px;bottom:0;'
    document.body.append(host)
    return host
  }

  return {
    channels: () => internals.map((entry) => entry.channel),
    active: () => active,
    setActive(channel) {
      active = channel
    },
    prepareActive() {
      const target = ensureHost()
      if (!target) return
      const element = byChannel.get(active)?.element()
      if (element && element.parentNode !== target) target.replaceChildren(element)
    },
    supportsOverlap: () => !options.backgroundSafe,
    supportsSpectrum: () => spectrumAvailable,
    setMasterVolume() {
      // 总音量变化后各路要按自己的增益重算
      for (const entry of internals) entry.channel.setGain(entry.channel.gain())
    },
    elementOf(channel) {
      const entry = byChannel.get(channel)
      if (!entry) throw new Error('unknown audio channel')
      return entry.element()
    },
    degradeForTaint(element) {
      const entry = internals.find((item) => item.element() === element)
      if (entry) {
        // 换成无 crossOrigin 的元素:句柄与其上的订阅不变,上层无感
        entry.swapElement(createElement(element.preload, undefined))
      }
      if (spectrumAvailable) {
        spectrumAvailable = false
        options.onSpectrumLost?.()
      }
    },
    dispose() {
      for (const entry of internals) {
        entry.channel.release()
      }
      host?.remove()
      host = null
    },
  }
}
