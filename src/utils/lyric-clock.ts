// 歌词播放时钟:把 <audio> 的 timeupdate(约 4Hz)外推成 60fps 的连续时间轴。
//
// 逐字歌词的扫光和行间弹簧滚动都需要每帧的播放位置,4Hz 采样直接用会让扫光每 250ms
// 跳一格。这里以每次 timeupdate 为锚点做线性外推,锚点更新自动校正漂移;
// 缓冲 stall 期间 timeupdate 停发但 rAF 仍在跑,外推增量封顶避免跑到音频前面去。
//
// 纯数据结构,不持有 rAF、不读 DOM/BOM:调用方负责传入单调时间戳(performance.now())。

export interface LyricClock {
  /** timeupdate 锚点:重设参考点并立即校正当前读数 */
  anchor(mediaTime: number, stamp: number): void
  /** 读取外推后的播放位置(秒) */
  read(stamp: number): number
  /** 播放速率变化时同步(倍速播放/变速不变调) */
  setRate(rate: number): void
  /** 冻结:暂停时停止外推,读数固定在最后一次锚点 */
  freeze(): void
  /** 解冻并以给定时间重锚。恢复播放必须走这里,否则首帧会跨越整个暂停时长 */
  resume(mediaTime: number, stamp: number): void
  /** 当前是否处于外推状态 */
  readonly running: boolean
}

export interface LyricClockOptions {
  /**
   * 单次锚点之后允许外推的最大秒数。缓冲 stall 时 timeupdate 停发,
   * 不封顶的话歌词会一路超前于实际音频,恢复后整体回跳。
   */
  maxDriftSeconds?: number
}

const DEFAULT_MAX_DRIFT_SECONDS = 1

export function createLyricClock(options: LyricClockOptions = {}): LyricClock {
  const maxDrift = options.maxDriftSeconds ?? DEFAULT_MAX_DRIFT_SECONDS
  let anchorTime = 0
  let anchorStamp = 0
  let rate = 1
  let frozen = true

  return {
    anchor(mediaTime: number, stamp: number) {
      if (!Number.isFinite(mediaTime) || !Number.isFinite(stamp)) return
      anchorTime = mediaTime
      anchorStamp = stamp
    },
    read(stamp: number): number {
      if (frozen || !Number.isFinite(stamp)) return anchorTime
      const elapsed = ((stamp - anchorStamp) / 1000) * rate
      if (elapsed <= 0) return anchorTime
      return anchorTime + Math.min(elapsed, maxDrift)
    },
    setRate(nextRate: number) {
      if (!Number.isFinite(nextRate) || nextRate <= 0) return
      rate = nextRate
    },
    freeze() {
      frozen = true
    },
    resume(mediaTime: number, stamp: number) {
      if (!Number.isFinite(mediaTime) || !Number.isFinite(stamp)) return
      anchorTime = mediaTime
      anchorStamp = stamp
      frozen = false
    },
    get running() {
      return !frozen
    },
  }
}
