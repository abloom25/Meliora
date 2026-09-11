// 歌词核心的唯一对外入口。
//
// 这一层是**纯的**:解析歌词文本、补齐时间轴、算出某一时刻该亮哪几行、按行高排版,
// 全部只吃数据、只吐数据,不碰 DOM、不依赖 Vue、不发网络请求。渲染(Web 面板、
// 歌词小窗、进度条气泡)和获取(services/lyrics)都建在它上面,桌面端可以原样搬走。
//
// 数据流:
//   文本 → parseAnyLyrics(按内容识别 TTML / YRC / QRC / 增强型 LRC / 普通 LRC)
//        → resolveLyricTimings(补每行的结束时间与音节序列)
//        → resolveLyricScene(某一时刻:哪几行在唱、锚点是谁、和声是否展开)
//        → layoutLyricLines(按行高排出纵坐标)
//   逐帧的播放位置由 createLyricClock 从稀疏的 timeupdate 外推。
//
// 外部一律从这里引入,不要深入到具体文件 —— 目录结构可以变,这个入口不变。

export {
  MIN_WORD_DURATION,
  findActiveLyricIndex,
  findActiveLyricIndices,
  hasMeaningfulLyrics,
  isInstrumentalPlaceholder,
  joinWords,
  lineWeight,
  mergeLyricTranslations,
  mergeSyllablesIntoWords,
  parseLyrics,
  resolveLyricTimings,
  splitLyricTranslation,
  tokenizeLyricText,
  wordEdgeSoftness,
  wordFillProgress,
  type ActiveLyricLines,
  type WeightedToken,
} from './lyrics'

export { detectLyricFormat, parseAnyLyrics, type LyricSourceFormat } from './source'

export { parseTtmlLyrics } from './ttml'

export { looksLikeWordTimedLyrics, parseWordTimedLyrics } from './yrc'

export { createLyricClock, type LyricClock, type LyricClockOptions } from './clock'

export {
  harmonyParentsOf,
  layoutLyricLines,
  lyricFocusOffset,
  lyricTempoScale,
  nextPrimaryTime,
  resolveLyricScene,
  sameLyricScene,
  type LyricLayout,
  type LyricLayoutInput,
  type LyricScene,
} from './scene'
