// 播放后端的契约。编排层(队列推进、淡入淡出、进度同步)只认这里,不认 HTMLAudioElement。
//
// Web 端由 <audio> 元素池实现;桌面端(Tauri)由原生后端实现。两边只要满足这组方法,
// 上层不需要改。
//
// 关键约定:**通道是稳定句柄**。后端可以在内部把底下的实现整个换掉
// (Web 端跨源音频被 Web Audio 污染后必须丢掉 crossOrigin 重建元素),
// 但句柄本身和它上面的事件订阅必须存活 —— 上层持有的引用不该因为这种内部动作而失效。
//
// 其余约定:
// - 方法幂等、不抛错。加载与解码失败一律走 'error' 事件,不要用异常。
// - `gain` 是这一路的独立音量(0…1),用于交叉淡入淡出;与用户设置的总音量相乘由后端合成。
// - `seek` 在时长未知时应记住目标位置,等时长可用后再落位。

import type { PlaybackFailureReason } from './failure'

export type AudioChannelEvent =
  | 'timeupdate'
  | 'durationchange'
  | 'loadedmetadata'
  | 'canplay'
  | 'loadeddata'
  | 'play'
  | 'pause'
  | 'ended'
  | 'error'

/** 一路播放通道。交叉淡入淡出需要同时存在两路 */
export interface AudioChannel {
  /** 稳定标识,调试与日志用 */
  readonly id: string
  /** 指向新的音频地址并开始加载。不自动播放 */
  load(url: string): void
  /** 当前音频地址;没有源时为空串 */
  source(): string
  /** 暂停、清空源、中止下载 */
  release(): void
  play(): Promise<void>
  pause(): void
  currentTime(): number
  seek(seconds: number): void
  /** 时长(秒);未知时为 null */
  duration(): number | null
  setGain(gain: number): void
  gain(): number
  /** 数据是否足够开始播放(预加载命中判定) */
  canStart(): boolean
  /** 是否处于错误态 */
  failed(): boolean
  /** 是否已经播到末尾 */
  ended(): boolean
  /** 把平台错误归一成平台无关的原因 */
  classifyFailure(error: unknown): PlaybackFailureReason
  /** 订阅事件,返回退订函数 */
  on(event: AudioChannelEvent, listener: () => void): () => void
}

export interface AudioBackend {
  /** 全部通道。第一路是出声通道,其余给预加载 */
  channels(): readonly AudioChannel[]
  active(): AudioChannel
  setActive(channel: AudioChannel): void
  /** 让当前出声通道满足平台的后台播放要求(iOS 需要把元素挂进文档) */
  prepareActive(): void
  /** 平台能否两路同时出声。不能则不做交叉淡入淡出,也不提前切歌 */
  supportsOverlap(): boolean
  /** 平台能否提供频谱/节拍分析。跨源素材被拒后会变成 false */
  supportsSpectrum(): boolean
  /** 总音量(0…1),作用于所有通道 */
  setMasterVolume(volume: number): void
  dispose(): void
}
