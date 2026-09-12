// 播放失败的归类、文案与善后策略。
//
// 平台把自己的错误(Web 是 DOMException + MediaError.code,桌面端是原生后端的错误码)
// 先归一成 PlaybackFailureReason,之后"给用户看什么""要不要跳下一首"就与平台无关了。

export type PlaybackFailureReason =
  /** 用户或程序主动取消,不是真的失败,不该提示 */
  | 'aborted'
  /** 浏览器/系统的自动播放限制,需要用户再点一次 */
  | 'not-allowed'
  /** 这首歌压根没有音频地址 */
  | 'missing-source'
  /** 网络取不到音频 */
  | 'network'
  /** 拿到了数据但解不了码 */
  | 'decode'
  /** 地址或格式不被支持 */
  | 'unsupported'
  /** 说不清的失败 */
  | 'unknown'

/** 给用户看的一句话。'aborted' 返回空串表示"什么都别提示" */
export function describePlaybackFailure(reason: PlaybackFailureReason): string {
  switch (reason) {
    case 'aborted':
      return ''
    case 'not-allowed':
      return '浏览器阻止了播放，请再次点击播放'
    case 'missing-source':
      return '当前歌曲没有可用的音频地址'
    case 'network':
      return '当前歌曲音频加载失败，请稍后再试'
    case 'decode':
      return '浏览器无法解码当前音频'
    case 'unsupported':
      return '当前歌曲音频源暂时不可用或格式不支持'
    case 'unknown':
      return '当前歌曲无法播放，请稍后再试'
  }
}

export interface FailureContext {
  /** 用户是否开了「出错自动跳过」 */
  skipOnError: boolean
  /** 按当前播放模式,这首失败之后确实还有下一首可放 */
  hasNextTrack: boolean
  /** 是否有可以退回去的上一首(切歌失败时用它兜底) */
  canFallBack: boolean
}

export type FailureAction =
  /** 跳到下一首,并提示"已跳过" */
  | { kind: 'skip'; notice: string }
  /** 退回上一首继续放,把真实原因作为提示显示 */
  | { kind: 'fall-back'; notice: string }
  /** 干净地停下 */
  | { kind: 'stop' }

export const SKIP_NOTICE = '已跳过暂时无法播放的歌曲，正在继续播放'

/**
 * 一首歌放不了时怎么办。
 *
 * 关键约束:提示必须与真正会发生的事一致 —— 只有确实存在后继时才说"正在继续播放"。
 * 顺序播放到队尾、单曲循环里当前这首刚被拉黑,都属于"没有后继",
 * 此时若还提示继续播放,用户看到的是提示在播、实际却停了。
 */
export function resolveFailureAction(
  reason: PlaybackFailureReason,
  context: FailureContext,
): FailureAction {
  // 主动取消不是"这首歌放不了":最常见的是启动期间用户按了暂停。
  // 此时跳过会把"按一下暂停"变成"跳到下一首",而提示语本就是空串(见 describePlaybackFailure),
  // 于是用户看到的是无缘无故换了首歌。取消一律干净地停下。
  if (reason === 'aborted') return { kind: 'stop' }
  if (context.skipOnError && context.hasNextTrack) {
    return { kind: 'skip', notice: SKIP_NOTICE }
  }
  if (context.skipOnError && context.canFallBack) {
    // 退回旧曲目后它会重新开始播,成功时会清空错误信息,
    // 所以失败原因得走"提示"这一路,否则用户看不到为什么跳过
    return { kind: 'fall-back', notice: describePlaybackFailure(reason) }
  }
  return { kind: 'stop' }
}
