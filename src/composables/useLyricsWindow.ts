import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { LyricLine, LyricWord, LyricsSnapshot, Track } from '../types/music'
import { isApplePlatform, supportsDocumentPictureInPicture } from '../utils/browser'
import { createLyricClock } from '../utils/lyric-clock'
import { wordFillProgress } from '../utils/lyrics'
import { listenMediaQuery } from '../utils/media-query'

interface DocumentPictureInPictureApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>
}

interface LyricsWindowOptions {
  currentTrack: Ref<Track | null>
  isPlaying: Ref<boolean>
  /** 播放位置(秒)。小窗内的逐字扫光靠它驱动自己的外推时钟 */
  currentTime: Ref<number>
  /** 歌词动画开关。关掉后小窗同样停掉逐字扫光,整行一次性高亮 */
  lyricAnimation: Ref<boolean>
}

interface CachedNodes {
  cover: HTMLImageElement
  title: HTMLElement
  artist: HTMLElement
  background: HTMLElement
  lyricsViewport: HTMLElement
  lyricsContainer: HTMLElement
  state: HTMLElement
  lineNodes: HTMLDivElement[]
  mainNodes: HTMLSpanElement[]
  translationNodes: (HTMLSpanElement | null)[]
  /** 每个槽位的音节节点,逐字扫光每帧只写这里 */
  wordNodes: HTMLElement[][]
  /** 每个槽位当前渲染的内容指纹,不变就不重建 DOM */
  signatures: string[]
}

const popupStyles = `
  :root { color-scheme: dark; font-family: -apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif; --lyric-size: clamp(18px,min(5.4vw,6vh),38px); --line-gap: clamp(8px,2.2vh,18px); --cover-size: clamp(32px,min(11vw,10vh),56px); }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html,body { width: 100%; height: 100%; }
  body { margin: 0; overflow: hidden; background: #17171a; color: #fff; }
  .background { position: fixed; inset: -15%; background-position: center; background-size: cover; filter: blur(55px) saturate(1.2); opacity: .55; transform: scale(1.15); }
  .shade { position: fixed; inset: 0; background: linear-gradient(180deg,rgba(10,10,12,.32),rgba(10,10,12,.82)); }
  main { position: relative; display: flex; width: 100%; height: 100vh; height: 100dvh; min-height: 0; flex-direction: column; gap: clamp(8px,3vh,24px); padding: max(env(safe-area-inset-top),clamp(10px,4vh,28px)) max(env(safe-area-inset-right),clamp(12px,6vw,48px)) max(env(safe-area-inset-bottom),clamp(10px,4vh,28px)) max(env(safe-area-inset-left),clamp(12px,6vw,48px)); }
  header { display: grid; flex: none; min-width: 0; grid-template-columns: var(--cover-size) minmax(0,1fr); align-items: center; gap: clamp(8px,2.8vw,14px); }
  .cover { width: var(--cover-size); height: var(--cover-size); border-radius: 26%; object-fit: cover; background: rgba(255,255,255,.1); box-shadow: 0 10px 30px rgba(0,0,0,.3); }
  .copy { min-width: 0; }
  h1,p { overflow: hidden; margin: 0; text-overflow: ellipsis; white-space: nowrap; }
  h1 { font-size: clamp(13px,3.5vw,17px); letter-spacing: -.02em; }
  p { margin-top: 4px; color: rgba(255,255,255,.56); font-size: 12px; }
  /* 自动外边距只在有剩余空间时居中;超长活跃组从顶部滚动,不会向上溢出而无法读全。 */
  .lyrics { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.2) transparent; }
  .lyrics-lines { display: flex; flex: none; width: 100%; margin-block: auto; padding: .15em .12em .2em; flex-direction: column; gap: var(--line-gap); font-size: var(--lyric-size); }
  .lyrics-lines:empty { display: none; }
  .lyrics.scrolling { overflow: hidden; }
  .line { --lyric-fill: rgba(255,255,255,.27); --lyric-idle: rgba(255,255,255,.27); flex: none; min-width: 0; overflow-wrap: anywhere; color: var(--lyric-fill); font-size: var(--lyric-size); font-weight: 690; line-height: 1.22; letter-spacing: -.035em; transition: opacity calc(.45s * var(--lyric-tempo,1)) ease,color calc(.45s * var(--lyric-tempo,1)) ease,text-shadow calc(.45s * var(--lyric-tempo,1)) ease; }
  .line.active { --lyric-fill: #fff; --lyric-idle: rgba(255,255,255,.32); text-shadow: 0 0 20px rgba(255,255,255,.18); }
  .main { display: block; }
  .line.secondary { text-align: right; }
  .line.harmony { font-size: .84em; opacity: .82; }
  .apple-font .line { font-family: -apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC",sans-serif; font-weight: 700; font-synthesis: weight; }
  /* 逐字扫光。弹窗文档里没有 @property 注册,var() 必须带兜底值,
     否则未写入的音节会让整条 background-image 失效、文字变透明 */
  /* padding 撑开背景绘制盒、负 margin 抵消排版影响:否则 background-clip: text 会把 g/y/p 的降部切掉;
     横向同理——letter-spacing: -.035em 让盒宽比末字字形窄,不留余量字会被左右削掉一道 */
  .word { display: inline-block; max-width: 100%; padding: .08em .12em .16em; margin: -.08em -.12em -.16em; color: var(--lyric-fill); translate: 0 calc(var(--w,1) * -.05em); }
  @supports (background-clip: text) or (-webkit-background-clip: text) {
    /* --e 是前沿柔化宽度的缩放,进度为 0 或 1 时收到 0;
       否则未唱词的左边缘会被画出一段亮色渐变 */
    .word { color: transparent; -webkit-background-clip: text; background-clip: text; background-image: linear-gradient(90deg, var(--lyric-fill) 0%, var(--lyric-fill) calc(var(--w,1) * 100%), var(--lyric-idle) calc(var(--w,1) * 100% + .5em * var(--e,0)), var(--lyric-idle) 100%); }
  }
  .gap { white-space: pre-wrap; }
  .translation { display: block; margin-top: .25em; font-size: max(12px,.68em); line-height: 1.4; letter-spacing: 0; opacity: .72; }
  .state { margin: auto 0; padding-block: .25em; overflow-wrap: anywhere; color: rgba(255,255,255,.5); font-size: clamp(14px,4vw,18px); font-weight: 620; }
  @media (max-width: 300px) {
    main { padding-inline: max(env(safe-area-inset-left),12px) max(env(safe-area-inset-right),12px); }
    header { gap: 8px; }
  }
  /* 横向矮窗把歌曲信息移到侧边,将高度留给歌词。 */
  @media (min-width: 480px) and (max-height: 360px) {
    main { flex-direction: row; align-items: stretch; gap: clamp(16px,4vw,32px); padding-inline: max(env(safe-area-inset-left),clamp(16px,3vw,32px)) max(env(safe-area-inset-right),clamp(16px,3vw,32px)); }
    header { width: clamp(112px,23vw,200px); align-content: center; grid-template-columns: minmax(0,1fr); gap: 10px; }
    .lyrics { flex: 1; }
  }
  @media (max-height: 240px) {
    :root { --lyric-size: clamp(16px,min(4.6vw,10vh),24px); --line-gap: 6px; --cover-size: 28px; }
    main { gap: 8px; }
    h1 { font-size: 13px; }
    p { margin-top: 2px; font-size: 11px; }
  }
  @media (max-height: 150px) {
    header { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .line { transition: none; }
    .word { translate: none; }
  }
  @media (prefers-contrast: more) {
    .line { --lyric-fill: rgba(255,255,255,.65); --lyric-idle: rgba(255,255,255,.65); }
    .line.active { --lyric-fill: #fff; --lyric-idle: rgba(255,255,255,.65); }
    .translation,.line.harmony { opacity: 1; }
  }
`

const POPUP_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meliora 歌词</title><style>${popupStyles}</style></head><body><div class="background"></div><div class="shade"></div><main><header><img class="cover" alt=""><div class="copy"><h1></h1><p></p></div></header><section class="lyrics" tabindex="0" aria-label="歌词"><div class="state" role="status"></div><div class="lyrics-lines"></div></section></main></body></html>`

const CLOSED_POLL_INTERVAL = 800
const SCROLL_DURATION = 420

// Safari 在窗口销毁后访问 closed 属性可能抛错,统一用 try/catch 兜底
function isWindowClosed(target: Window): boolean {
  try {
    return target.closed
  } catch {
    return true
  }
}

export function useLyricsWindow({
  currentTrack,
  isPlaying,
  currentTime,
  lyricAnimation,
}: LyricsWindowOptions) {
  const snapshot = ref<LyricsSnapshot>({
    lines: [],
    activeIndex: -1,
    status: 'idle',
  })
  const isOpen = ref(false)
  let lyricsWindow: Window | null = null
  let openingWindow: Window | null = null
  let cachedNodes: CachedNodes | null = null
  let closedPollTimer = 0
  let readyCheckTimer = 0
  let resolveReadyCheck: (() => void) | null = null
  let isToggling = false
  let isDisposed = false
  let windowCloseListeners: Array<() => void> = []
  let layoutFrame = 0
  let renderedTrackId: Track['id'] | undefined
  let renderedActiveIndex = -1
  let lyricsRenderKey = ''
  let previousPositions: Map<string, number> | null = null
  let scrollDirection = 1
  let reducedMotion: MediaQueryList | null = null
  const scrollAnimations = new Map<HTMLElement, Animation>()
  // 小窗自己维护一份外推时钟与 rAF 循环:主窗口在后台时 rAF 会被节流到约 1Hz,
  // 扫光必须跑在小窗自己的帧循环上才能保持平滑
  const clock = createLyricClock()
  let karaokeFrame = 0
  // 同一时刻可以有多行在唱(对唱双声部、背景和声),扫光要按整批槽位绑
  let activeSlots: Array<{ slot: number; words: LyricWord[] }> = []
  let karaokeSpans: HTMLElement[] = []
  let karaokeWords: LyricWord[] = []
  let karaokeLastFill: string[] = []
  let karaokeLastEdge: string[] = []

  function setSnapshot(value: LyricsSnapshot) {
    snapshot.value = value
    render()
  }

  function clearCache() {
    stopScrollAnimations()
    previousPositions = null
    renderedTrackId = undefined
    renderedActiveIndex = -1
    lyricsRenderKey = ''
    reducedMotion = null
    cachedNodes = null
  }

  function teardownWindow(target: Window) {
    for (const cleanup of windowCloseListeners) {
      try {
        cleanup()
      } catch {
        // 监听器可能已随窗口销毁,忽略
      }
    }
    windowCloseListeners = []
    if (layoutFrame) {
      try {
        target.cancelAnimationFrame(layoutFrame)
      } catch {
        // Safari 可能在关闭事件触发前就已回收窗口。
      }
      layoutFrame = 0
    }
    if (closedPollTimer) {
      window.clearInterval(closedPollTimer)
      closedPollTimer = 0
    }
    if (readyCheckTimer) {
      window.clearInterval(readyCheckTimer)
      readyCheckTimer = 0
      const resolve = resolveReadyCheck
      resolveReadyCheck = null
      resolve?.()
    }
    if (lyricsWindow === target) {
      stopKaraoke()
      releaseKaraoke()
      activeSlots = []
      lyricsWindow = null
      isOpen.value = false
      clearCache()
    }
  }

  function registerCloseDetection(target: Window) {
    const handleClosed = () => {
      if (lyricsWindow === target) teardownWindow(target)
    }
    // Safari 对弹窗的 pagehide/beforeunload/unload 触发时机不一致,
    // 三个事件都监听以覆盖不同 Safari 版本与关闭路径。
    const events = ['pagehide', 'beforeunload', 'unload']
    for (const event of events) {
      try {
        target.addEventListener(event, handleClosed)
        windowCloseListeners.push(() => {
          try {
            target.removeEventListener(event, handleClosed)
          } catch {
            // 窗口可能已销毁
          }
        })
      } catch {
        // 某些环境下 addEventListener 可能抛错,忽略
      }
    }
    // Safari 在某些关闭路径(如点击标题栏关闭按钮)下可能完全不触发上述事件,
    // 需要轮询 closed 属性作为兜底。
    closedPollTimer = window.setInterval(() => {
      if (lyricsWindow !== target) {
        // 窗口还在打开流程中(createDocument 是异步的,lyricsWindow 尚未赋值):
        // 跳过本次检查但保留轮询,否则 Safari 标题栏关闭路径会失去兜底。
        if (openingWindow === target) return
        window.clearInterval(closedPollTimer)
        closedPollTimer = 0
        return
      }
      if (isWindowClosed(target)) {
        window.clearInterval(closedPollTimer)
        closedPollTimer = 0
        handleClosed()
      }
    }, CLOSED_POLL_INTERVAL)
  }

  function writeDocument(target: Window) {
    // Safari 对 DOMParser 生成的独立 Document 通过 replaceChildren 跨窗口移植节点支持不可靠
    // (样式上下文丢失、节点归属权异常)。改用 document.write 写入完整 HTML,
    // 这是所有浏览器(含旧 Safari)最兼容的同源弹窗内容注入方式。
    try {
      target.document.open()
      target.document.write(POPUP_HTML)
      target.document.close()
      target.document.documentElement.classList.toggle('apple-font', isApplePlatform())
    } catch {
      // 极少数情况下 document.write 会抛错(如窗口已被回收),交给上层处理
      throw new Error('Failed to write lyrics window document')
    }
  }

  function waitForDocumentReady(target: Window): Promise<void> {
    return new Promise<void>((resolve) => {
      if (target.document.readyState === 'complete') {
        resolve()
        return
      }
      resolveReadyCheck = resolve
      let attempts = 0
      readyCheckTimer = window.setInterval(() => {
        attempts += 1
        if (target.document.readyState === 'complete' || attempts > 20) {
          window.clearInterval(readyCheckTimer)
          readyCheckTimer = 0
          resolveReadyCheck = null
          resolve()
        }
      }, 50)
    })
  }

  function cacheNodes(target: Window) {
    const cover = target.document.querySelector<HTMLImageElement>('.cover')
    const title = target.document.querySelector<HTMLElement>('h1')
    const artist = target.document.querySelector<HTMLElement>('header p')
    const background = target.document.querySelector<HTMLElement>('.background')
    const lyricsViewport = target.document.querySelector<HTMLElement>('.lyrics')
    const lyricsContainer = target.document.querySelector<HTMLElement>('.lyrics-lines')
    const state = target.document.querySelector<HTMLElement>('.state')

    if (cover && title && artist && background && lyricsViewport && lyricsContainer && state) {
      cachedNodes = {
        cover,
        title,
        artist,
        background,
        lyricsViewport,
        lyricsContainer,
        state,
        lineNodes: [],
        mainNodes: [],
        translationNodes: [],
        wordNodes: [],
        signatures: [],
      }
    } else {
      cachedNodes = null
    }
  }

  async function createDocument(target: Window) {
    writeDocument(target)
    await waitForDocumentReady(target)
    cacheNodes(target)
    registerCloseDetection(target)
    registerLayout(target)
  }

  function stopScrollAnimations(): void {
    for (const [node, animation] of scrollAnimations) {
      animation.onfinish = null
      animation.cancel()
      node.style.removeProperty('will-change')
    }
    scrollAnimations.clear()
    cachedNodes?.lyricsViewport.classList.remove('scrolling')
  }

  function canAnimateScroll(): boolean {
    return lyricAnimation.value && !reducedMotion?.matches
  }

  function capturePositions(): Map<string, number> {
    const positions = new Map<string, number>()
    if (!cachedNodes) return positions
    for (const node of cachedNodes.lineNodes) {
      if (node.parentNode === cachedNodes.lyricsContainer && !node.hidden) {
        // 包含尚未完成的动画位移,快速换句从眼前的位置接续,不会先跳回旧终点。
        positions.set(node.dataset.index!, node.getBoundingClientRect().top)
      }
    }
    return positions
  }

  function animateScroll(positions: Map<string, number>): void {
    if (!cachedNodes || !positions.size || !canAnimateScroll()) return
    const { lyricsViewport, lyricsContainer, lineNodes } = cachedNodes
    if (typeof lyricsContainer.animate !== 'function') return
    const visibleNodes = lineNodes.filter(
      (node) => node.parentNode === lyricsContainer && !node.hidden,
    )
    // 整组共享一个位移,行间距始终由 flex 布局保证。逐行 FLIP 在长短句混排、
    // 上下文收起/恢复时起点不同,新行还可能穿过正在移动的旧行。
    const retained = visibleNodes.filter((node) => positions.has(node.dataset.index!))
    const anchor = retained.find((node) => node.classList.contains('active')) ?? retained[0]
    const offset = anchor
      ? positions.get(anchor.dataset.index!)! - anchor.getBoundingClientRect().top
      : Math.min(48, lyricsViewport.clientHeight * 0.25) * scrollDirection
    if (Math.abs(offset) < 0.5) return
    const duration = SCROLL_DURATION * Math.max(0.25, Math.min(1, snapshot.value.tempoScale ?? 1))
    // 只在换句时测一次终点,浏览器合成整个歌词组的位移,不逐帧量布局。
    lyricsContainer.style.willChange = 'transform'
    const animation = lyricsContainer.animate(
      [
        { transform: `translateY(${offset}px)`, ...(!anchor ? { opacity: 0 } : {}) },
        { transform: 'translateY(0)' },
      ],
      { duration, easing: 'cubic-bezier(.16,1,.3,1)' },
    )
    scrollAnimations.set(lyricsContainer, animation)
    animation.onfinish = () => {
      if (scrollAnimations.get(lyricsContainer) !== animation) return
      scrollAnimations.delete(lyricsContainer)
      lyricsContainer.style.removeProperty('will-change')
      lyricsViewport.classList.remove('scrolling')
    }
    lyricsViewport.classList.add('scrolling')
  }

  function fitLyrics(): void {
    if (!cachedNodes) return
    const { lyricsViewport, lyricsContainer, lineNodes } = cachedNodes
    const nodes = lineNodes.filter((node) => node.parentNode === lyricsContainer)
    for (const node of nodes) node.hidden = false

    const availableHeight = lyricsViewport.clientHeight
    if (!availableHeight || !nodes.length) return
    const activeNodes = nodes.filter((node) => node.classList.contains('active'))
    // 纯文本/前奏至少留第一句;对唱和和声属于同一个活跃组,不能为塞入上下文而隐藏。
    const anchors = activeNodes.length ? activeNodes : nodes.slice(0, 1)
    const distance = (node: HTMLElement): number =>
      Math.min(
        ...anchors.map((anchor) =>
          Math.abs(Number(node.dataset.index) - Number(anchor.dataset.index)),
        ),
      )
    const context = nodes
      .filter((node) => !anchors.includes(node))
      .sort(
        (a, b) => distance(b) - distance(a) || Number(a.dataset.index) - Number(b.dataset.index),
      )
    // 最多几个槽位,按实际换行高度逐个移除远行,译文和长句也能参与空间分配。
    for (const node of context) {
      if (lyricsContainer.offsetHeight <= availableHeight) break
      node.hidden = true
    }
    lyricsViewport.scrollTop = 0
  }

  function scheduleLayout(): void {
    const target = lyricsWindow
    if (!target || layoutFrame || isWindowClosed(target)) return
    layoutFrame = target.requestAnimationFrame(() => {
      layoutFrame = 0
      if (lyricsWindow !== target || isWindowClosed(target)) return
      const positions = previousPositions
      previousPositions = null
      fitLyrics()
      if (positions) animateScroll(positions)
    })
  }

  function resetLayout(): void {
    previousPositions = null
    stopScrollAnimations()
    scheduleLayout()
  }

  function registerLayout(target: Window): void {
    target.addEventListener('resize', resetLayout, { passive: true })
    windowCloseListeners.push(() => target.removeEventListener('resize', resetLayout))
    const viewport = target.visualViewport
    viewport?.addEventListener('resize', resetLayout, { passive: true })
    windowCloseListeners.push(() => viewport?.removeEventListener('resize', resetLayout))
    reducedMotion = target.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
    if (reducedMotion) windowCloseListeners.push(listenMediaQuery(reducedMotion, resetLayout))
    // 必须用弹窗自己的观察器和帧循环,主页面在后台时仍能响应拖动窗口。
    const Observer = (target as Window & typeof globalThis).ResizeObserver
    if (Observer && cachedNodes) {
      const observer = new Observer(resetLayout)
      observer.observe(cachedNodes.lyricsViewport)
      windowCloseListeners.push(() => observer.disconnect())
    }
    void target.document.fonts?.ready.then(() => {
      if (lyricsWindow === target) resetLayout()
    })
  }

  function reuseLineNodes(start: number, end: number): void {
    const nodes = cachedNodes!
    const entries = nodes.lineNodes.map((node, slot) => ({
      node,
      main: nodes.mainNodes[slot]!,
      translation: nodes.translationNodes[slot] ?? null,
      words: nodes.wordNodes[slot]!,
      signature: nodes.signatures[slot]!,
    }))
    const retained = new Map(
      entries
        .filter(({ node }) => {
          const index = Number(node.dataset.index)
          return index >= start && index < end
        })
        .map((entry) => [Number(entry.node.dataset.index), entry]),
    )
    const spare = entries.filter((entry) => !retained.has(Number(entry.node.dataset.index)))
    const ordered: typeof entries = []
    for (let index = start; index < end; index += 1) {
      const entry = retained.get(index) ?? spare.shift()
      if (entry) ordered.push(entry)
      else {
        // 新槽位由 ensureLineNode 创建;先补齐剩余容量,避免重用仍在窗口内的行。
        const slot = nodes.lineNodes.length
        const node = ensureLineNode(slot, lyricsWindow!.document)
        ordered.push({
          node,
          main: nodes.mainNodes[slot]!,
          translation: null,
          words: [],
          signature: '',
        })
      }
    }
    for (const { node } of spare) node.remove()
    nodes.lineNodes = ordered.map((entry) => entry.node)
    nodes.mainNodes = ordered.map((entry) => entry.main)
    nodes.translationNodes = ordered.map((entry) => entry.translation)
    nodes.wordNodes = ordered.map((entry) => entry.words)
    nodes.signatures = ordered.map((entry) => entry.signature)
  }

  function ensureLineNode(index: number, doc: Document): HTMLDivElement {
    const nodes = cachedNodes!
    let node = nodes.lineNodes[index]
    if (!node) {
      node = doc.createElement('div')
      const main = doc.createElement('span')
      main.className = 'main'
      node.append(main)
      nodes.lineNodes[index] = node
      nodes.mainNodes[index] = main
      nodes.translationNodes[index] = null
      nodes.wordNodes[index] = []
      nodes.signatures[index] = ''
    }
    return node
  }

  // 内容指纹:文本、音节数、译文都没变就不重建 DOM,
  // 副歌里同一句反复出现时避免每次换行都扔掉重建一遍音节节点
  function lineSignature(line: LyricLine): string {
    return JSON.stringify([
      line.words?.map((word) => [word.text, Boolean(word.trailingSpace)]),
      line.text,
      line.translation ?? '',
    ])
  }

  function renderLineContent(doc: Document, slot: number, line: LyricLine) {
    const nodes = cachedNodes!
    const node = nodes.lineNodes[slot]!
    const main = nodes.mainNodes[slot]!
    const signature = lineSignature(line)
    if (nodes.signatures[slot] === signature) return
    nodes.signatures[slot] = signature

    const spans: HTMLElement[] = []
    if (line.words?.length) {
      const fragment = doc.createDocumentFragment()
      for (const word of line.words) {
        const span = doc.createElement('span')
        span.className = 'word'
        span.textContent = word.text
        fragment.append(span)
        spans.push(span)
        if (!word.trailingSpace) continue
        // 音节之间必须有真实的空白文本节点,否则行内块之间没有换行机会
        const gap = doc.createElement('span')
        gap.className = 'gap'
        gap.textContent = ' '
        fragment.append(gap)
      }
      main.replaceChildren(fragment)
    } else {
      main.textContent = line.text
    }
    nodes.wordNodes[slot] = spans

    let translationNode = nodes.translationNodes[slot]
    if (line.translation) {
      if (!translationNode) {
        translationNode = doc.createElement('span')
        translationNode.className = 'translation'
        nodes.translationNodes[slot] = translationNode
      }
      if (translationNode.textContent !== line.translation) {
        translationNode.textContent = line.translation
      }
      if (translationNode.parentNode !== node) node.append(translationNode)
    } else if (translationNode?.parentNode) {
      translationNode.remove()
    }
  }

  function releaseKaraoke() {
    for (const span of karaokeSpans) {
      span.style.removeProperty('--w')
      span.style.removeProperty('--e')
    }
    karaokeSpans = []
    karaokeWords = []
    karaokeLastFill = []
    karaokeLastEdge = []
  }

  function bindKaraoke() {
    releaseKaraoke()
    // 扫光关闭时不接管任何音节:释放内联的 --w / --e 后,
    // 样式里的兜底值 var(--w,1) 让整行按已唱完渲染,等同整行高亮
    if (!lyricAnimation.value || !cachedNodes) return

    const spans: HTMLElement[] = []
    const words: LyricWord[] = []
    for (const entry of activeSlots) {
      const slotSpans = cachedNodes.wordNodes[entry.slot]
      // 数量对不上说明 DOM 与快照不同步,整批都先不接管,下一次 render 会重绑
      if (!slotSpans || slotSpans.length !== entry.words.length) return
      spans.push(...slotSpans)
      words.push(...entry.words)
    }
    if (!spans.length) return

    karaokeSpans = spans
    karaokeWords = words
    karaokeLastFill = words.map(() => '')
    karaokeLastEdge = words.map(() => '')
  }

  function writeKaraoke(time: number) {
    for (let index = 0; index < karaokeSpans.length; index += 1) {
      const span = karaokeSpans[index]!
      const word = karaokeWords[index]!
      const progress = wordFillProgress(time, word)
      const fill = progress.toFixed(3)
      if (fill !== karaokeLastFill[index]) {
        karaokeLastFill[index] = fill
        span.style.setProperty('--w', fill)
      }
      const edge = Math.max(0, Math.min(1, Math.min(progress, 1 - progress) * 8)).toFixed(3)
      if (edge !== karaokeLastEdge[index]) {
        karaokeLastEdge[index] = edge
        span.style.setProperty('--e', edge)
      }
    }
  }

  function shouldRunKaraoke(): boolean {
    return Boolean(lyricsWindow && isPlaying.value && karaokeSpans.length > 0)
  }

  function karaokeTick() {
    karaokeFrame = 0
    const target = lyricsWindow
    if (!target || isWindowClosed(target)) return
    writeKaraoke(clock.read(performance.now()))
    if (shouldRunKaraoke()) karaokeFrame = target.requestAnimationFrame(karaokeTick)
  }

  function startKaraoke() {
    const target = lyricsWindow
    if (karaokeFrame || !target || !shouldRunKaraoke()) return
    karaokeFrame = target.requestAnimationFrame(karaokeTick)
  }

  function stopKaraoke() {
    if (!karaokeFrame) return
    try {
      lyricsWindow?.cancelAnimationFrame(karaokeFrame)
    } catch {
      // 窗口可能已销毁,句柄随之失效
    }
    karaokeFrame = 0
  }

  function render() {
    const target = lyricsWindow
    if (!target) return

    if (isWindowClosed(target)) {
      teardownWindow(target)
      return
    }

    if (!cachedNodes) return

    const doc = target.document
    const track = currentTrack.value
    const { cover, title, artist, background, lyricsContainer, state, lineNodes } = cachedNodes

    const nextTitle = track?.title || 'Meliora'
    if (title.textContent !== nextTitle) title.textContent = nextTitle

    const nextCover = track?.cover || `${import.meta.env.BASE_URL}favicon.svg`
    if (cover.getAttribute('src') !== nextCover) cover.src = nextCover

    const nextBackground = track?.cover ? `url("${track.cover.replaceAll('"', '\\"')}")` : 'none'
    if (background.style.backgroundImage !== nextBackground) {
      background.style.backgroundImage = nextBackground
    }

    const nextArtist = track ? track.artist || '' : isPlaying.value ? '正在播放' : '已暂停'
    if (artist.textContent !== nextArtist) artist.textContent = nextArtist

    const lines = snapshot.value.lines
    const ready = snapshot.value.status === 'ready' && lines.length > 0

    if (!ready) {
      previousPositions = null
      stopScrollAnimations()
      renderedActiveIndex = -1
      lyricsRenderKey = ''
      stopKaraoke()
      releaseKaraoke()
      activeSlots = []
      for (let i = 0; i < lineNodes.length; i += 1) {
        const node = lineNodes[i]
        if (node && node.parentNode) node.remove()
        cachedNodes.signatures[i] = ''
      }
      state.hidden = false
      state.textContent =
        snapshot.value.status === 'loading'
          ? '正在载入歌词'
          : snapshot.value.status === 'error'
            ? '歌词载入失败'
            : '暂无歌词'
      return
    }

    state.hidden = true
    state.textContent = ''

    const active = snapshot.value.activeIndex
    // 与主面板共享快节奏动画压缩系数,缺省按完整节奏处理
    const tempoScale = String(snapshot.value.tempoScale ?? 1)
    if (lyricsContainer.style.getPropertyValue('--lyric-tempo') !== tempoScale) {
      lyricsContainer.style.setProperty('--lyric-tempo', tempoScale)
    }
    const hasActiveLine = active >= 0 && active < lines.length
    // 缺省(旧快照)按只有锚点行处理
    const activeIndices = snapshot.value.activeIndices?.length
      ? snapshot.value.activeIndices
      : hasActiveLine
        ? [active]
        : []
    const activeSet = new Set(activeIndices)
    // 可见范围要盖住整个活跃组:对唱的另一声部可能在锚点之前,和声在其后
    const groupMin = activeIndices.length ? Math.min(...activeIndices, active) : active
    const groupMax = activeIndices.length ? Math.max(...activeIndices, active) : active
    const start = hasActiveLine ? Math.max(0, Math.min(active - 1, groupMin)) : 0
    const end = hasActiveLine
      ? Math.min(lines.length, Math.max(active + 3, groupMax + 1))
      : Math.min(lines.length, 4)
    const visibleCount = end - start
    const nextRenderKey = JSON.stringify([
      track?.id,
      active,
      activeIndices,
      tempoScale,
      lines.slice(start, end),
    ])
    if (lyricsRenderKey === nextRenderKey) return
    lyricsRenderKey = nextRenderKey
    const sameTrack = renderedTrackId === track?.id
    if (
      sameTrack &&
      renderedActiveIndex >= 0 &&
      active >= 0 &&
      renderedActiveIndex !== active &&
      canAnimateScroll()
    ) {
      previousPositions ??= capturePositions()
      scrollDirection = active > renderedActiveIndex ? 1 : -1
    } else {
      previousPositions = null
    }
    stopScrollAnimations()
    renderedTrackId = track?.id
    renderedActiveIndex = active
    activeSlots = []
    reuseLineNodes(start, end)

    for (let slot = 0; slot < visibleCount; slot += 1) {
      const lineIndex = start + slot
      const line = lines[lineIndex]!
      const node = ensureLineNode(slot, doc)

      const positionClass = !hasActiveLine
        ? 'after'
        : activeSet.has(lineIndex)
          ? 'active'
          : lineIndex < active
            ? 'before'
            : 'after'
      // 对唱的第二声部靠右,背景和声更小更淡 —— 和主面板同一套语义
      const roleClass = `${line.agent === 'secondary' ? ' secondary' : ''}${line.background ? ' harmony' : ''}`
      const desiredClass = `line ${positionClass}${roleClass}`
      if (node.className !== desiredClass) node.className = desiredClass
      const indexStr = String(lineIndex)
      if (node.dataset.index !== indexStr) node.dataset.index = indexStr

      renderLineContent(doc, slot, line)
      if (activeSet.has(lineIndex) && line.words?.length) {
        activeSlots.push({ slot, words: line.words })
      }

      if (node.parentNode !== lyricsContainer) {
        lyricsContainer.append(node)
      } else {
        const expectedNode = lyricsContainer.children[slot]
        if (expectedNode !== node) {
          lyricsContainer.insertBefore(node, expectedNode ?? null)
        }
      }
    }

    // 行内容重建后旧的音节节点已失效,每轮 render 结束都重新绑定扫光目标
    bindKaraoke()
    writeKaraoke(clock.read(performance.now()))
    startKaraoke()
    scheduleLayout()
  }

  async function openViaWindowOpen(): Promise<Window> {
    // 使用固定的窗口名称 'meliora-lyrics' 以便跨 toggle 操作重用同一窗口。
    // teardownWindow 在关闭/切换前会清理 cachedNodes 和事件监听器，
    // render() 开头通过 isWindowClosed 守卫确保不会在已销毁窗口上操作 DOM。
    const win = window.open('', 'meliora-lyrics', 'popup,width=430,height=600,resizable=yes')
    if (!win) throw new Error('Lyrics window was blocked')
    openingWindow = win
    try {
      await createDocument(win)
    } finally {
      if (openingWindow === win) openingWindow = null
    }
    return win
  }

  async function openViaDocumentPiP(): Promise<Window> {
    const pictureInPicture = (
      window as typeof window & { documentPictureInPicture?: DocumentPictureInPictureApi }
    ).documentPictureInPicture!
    const win = await pictureInPicture.requestWindow({ width: 430, height: 600 })
    // Document PiP 窗口的 document 是空白的,需要写入内容
    openingWindow = win
    try {
      await createDocument(win)
    } finally {
      if (openingWindow === win) openingWindow = null
    }
    return win
  }

  function closeWindowQuietly(target: Window) {
    try {
      target.close()
    } catch {
      // 窗口可能已销毁
    }
  }

  async function toggleLyricsWindow() {
    if (isToggling) return
    isToggling = true
    try {
      if (lyricsWindow) {
        if (!isWindowClosed(lyricsWindow)) {
          closeWindowQuietly(lyricsWindow)
          teardownWindow(lyricsWindow)
          return
        }
        teardownWindow(lyricsWindow)
      }

      let win: Window
      if (supportsDocumentPictureInPicture()) {
        win = await openViaDocumentPiP()
      } else {
        win = await openViaWindowOpen()
      }

      if (isDisposed) {
        closeWindowQuietly(win)
        teardownWindow(win)
        return
      }
      lyricsWindow = win
      isOpen.value = true
      render()
    } finally {
      isToggling = false
    }
  }

  watch(currentTime, (value) => {
    clock.anchor(value, performance.now())
    // 循环没跑时(暂停 / 无逐字数据)靠 timeupdate 驱动一次写入
    if (!karaokeFrame) writeKaraoke(clock.read(performance.now()))
  })
  watch(
    isPlaying,
    (playing) => {
      if (!playing) {
        clock.freeze()
        stopKaraoke()
        writeKaraoke(clock.read(performance.now()))
        return
      }
      // 暂停期间锚点持续老化,恢复播放必须重锚,否则首帧会跳到未来位置
      clock.resume(currentTime.value, performance.now())
      startKaraoke()
    },
    { immediate: true },
  )
  watch(lyricAnimation, () => {
    if (!lyricAnimation.value) {
      previousPositions = null
      stopScrollAnimations()
    }
    // 开关切换后立刻接管/交还当前行,不必等到下一次换行
    bindKaraoke()
    if (karaokeSpans.length) {
      writeKaraoke(clock.read(performance.now()))
      startKaraoke()
    } else {
      stopKaraoke()
    }
  })
  watch(
    [
      () => currentTrack.value?.id,
      () => currentTrack.value?.title,
      () => currentTrack.value?.artist,
      () => currentTrack.value?.cover,
      isPlaying,
    ],
    render,
  )
  onBeforeUnmount(() => {
    isDisposed = true
    stopKaraoke()
    if (openingWindow) {
      closeWindowQuietly(openingWindow)
      teardownWindow(openingWindow)
      openingWindow = null
    }
    if (lyricsWindow) {
      closeWindowQuietly(lyricsWindow)
      teardownWindow(lyricsWindow)
    }
  })

  return { isOpen, setSnapshot, toggleLyricsWindow }
}
