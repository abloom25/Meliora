// 组装点:把"平台实现"和"服务实现"装到只认接口的那些层上。
//
// 分层规定了依赖方向:core 不认识平台,stores 不认识 services。
// 但总得有**一个**地方把它们接起来,那就是这里 —— 应用启动时调一次。
// 桌面端有自己的入口,装的是自己的实现,其余各层原样复用。

import { usePlayerStore } from '../stores/player'
import { transferTrackLyricsProvider } from '../services/lyrics'

export function wireApplication(): void {
  const store = usePlayerStore()

  // 曲库刷新时曲目对象会被换新,已解析的歌词来源要跟着搬过去,
  // 否则正在播的这首会重新走一遍歌词请求
  store.onTrackReplaced(transferTrackLyricsProvider)
}
