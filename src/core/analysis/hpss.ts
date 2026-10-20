// 实时谐波 / 打击分离(DOM-free 纯模块)。
// Fitzgerald 2010《Harmonic/Percussive Separation Using Median Filtering》:
// 打击成分在频谱图上是竖线(瞬时、宽频),谐波成分是横线(持续、窄带);
// 沿时间方向取中值抑制竖线得到"谐波增强谱",沿频率方向取中值抑制横线得到"打击增强谱",
// 两者做 Wiener 型软掩膜(指数 p = 2)再乘回原谱。
// Stark / Robertson / Davies 2013 把它做成实时:时间方向只用最近 N 帧的因果中值,
// 当前帧的瞬态还没进入中值,于是在掩膜里天然归到打击一侧;不引入前视延迟。
// 本模块每帧只做 O(bins × 窗长) 的小排序,2048 点 FFT 下主线程开销远低于 1ms。

export interface RealtimeHpssOptions {
  /** 频谱 bin 数(analyser.frequencyBinCount) */
  bins: number
  /** 时间方向中值窗(帧),默认 9(60fps 下约 150ms 上下文) */
  timeFrames?: number
  /** 频率方向中值半宽(bin),默认 8(2048 点 @48kHz 下 ±190Hz) */
  frequencyHalfWidth?: number
  /** 掩膜指数,默认 2(原论文取值) */
  power?: number
}

export interface HpssFrame {
  /** 打击掩膜(0–1),按 bin 表示能量属于打击成分的比例 */
  percussiveMask: Float32Array
}

export interface RealtimeHpss {
  /** 输入当前帧的线性幅度谱,返回打击掩膜(谐波掩膜 = 1 - 打击掩膜) */
  process(magnitude: Float32Array): HpssFrame
  reset(): void
}

// 频率方向滑动窗中值:维护一个有序小数组,每前进一个 bin 移出最左值、插入最右值
function frequencyMedian(source: Float32Array, halfWidth: number, output: Float32Array) {
  const bins = source.length
  const sorted: number[] = []
  const insert = (value: number) => {
    let low = 0
    let high = sorted.length
    while (low < high) {
      const mid = (low + high) >> 1
      if ((sorted[mid] ?? 0) < value) low = mid + 1
      else high = mid
    }
    sorted.splice(low, 0, value)
  }
  const remove = (value: number) => {
    let low = 0
    let high = sorted.length
    while (low < high) {
      const mid = (low + high) >> 1
      if ((sorted[mid] ?? 0) < value) low = mid + 1
      else high = mid
    }
    // 浮点值来自同一数组,二分定位后就是它本身
    if (low < sorted.length) sorted.splice(low, 1)
  }
  for (let bin = 0; bin < Math.min(bins, halfWidth); bin += 1) insert(source[bin] ?? 0)
  for (let bin = 0; bin < bins; bin += 1) {
    const incoming = bin + halfWidth
    if (incoming < bins) insert(source[incoming] ?? 0)
    const outgoing = bin - halfWidth - 1
    if (outgoing >= 0) remove(source[outgoing] ?? 0)
    output[bin] = sorted[sorted.length >> 1] ?? 0
  }
}

export function createRealtimeHpss(options: RealtimeHpssOptions): RealtimeHpss {
  const bins = options.bins
  const timeFrames = Math.max(3, options.timeFrames ?? 9)
  const halfWidth = Math.max(1, options.frequencyHalfWidth ?? 8)
  const power = options.power ?? 2

  // 时间方向环形历史:frames[k] 是最近第 k 帧的幅度谱
  const history: Float32Array[] = []
  for (let i = 0; i < timeFrames; i += 1) history.push(new Float32Array(bins))
  let filled = 0
  let head = 0
  const scratch = new Float32Array(timeFrames)
  const harmonic = new Float32Array(bins)
  const percussive = new Float32Array(bins)
  const mask = new Float32Array(bins)

  function timeMedian(bin: number) {
    const count = filled
    for (let k = 0; k < count; k += 1) scratch[k] = history[k]?.[bin] ?? 0
    // 插入排序:窗长个位数,比通用排序快
    for (let i = 1; i < count; i += 1) {
      const value = scratch[i] ?? 0
      let j = i - 1
      while (j >= 0 && (scratch[j] ?? 0) > value) {
        scratch[j + 1] = scratch[j] ?? 0
        j -= 1
      }
      scratch[j + 1] = value
    }
    return scratch[count >> 1] ?? 0
  }

  return {
    process(magnitude) {
      const frame = history[head]
      if (frame) frame.set(magnitude.subarray(0, bins))
      head = (head + 1) % timeFrames
      filled = Math.min(timeFrames, filled + 1)
      frequencyMedian(magnitude, halfWidth, percussive)
      for (let bin = 0; bin < bins; bin += 1) {
        harmonic[bin] = timeMedian(bin)
        const p = Math.pow(percussive[bin] ?? 0, power)
        const h = Math.pow(harmonic[bin] ?? 0, power)
        const total = p + h
        mask[bin] = total > 1e-12 ? p / total : 0.5
      }
      return { percussiveMask: mask }
    },
    reset() {
      for (const frame of history) frame.fill(0)
      filled = 0
      head = 0
      mask.fill(0.5)
    },
  }
}
