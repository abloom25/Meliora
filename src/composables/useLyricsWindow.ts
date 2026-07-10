import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { LyricsSnapshot, Track } from '../types/music'
import { supportsDocumentPictureInPicture } from '../utils/browser'

interface DocumentPictureInPictureApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>
}

interface LyricsWindowOptions {
  currentTrack: Ref<Track | null>
  isPlaying: Ref<boolean>
}

interface CachedNodes {
  cover: HTMLImageElement
  title: HTMLElement
  artist: HTMLElement
  background: HTMLElement
  lyricsContainer: HTMLElement
  state: HTMLElement
  lineNodes: HTMLDivElement[]
  translationNodes: (HTMLSpanElement | null)[]
}

const popupStyles = `
  :root { color-scheme: dark; font-family: -apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; overflow: hidden; background: #17171a; color: #fff; }
  .background { position: fixed; inset: -15%; background-position: center; background-size: cover; filter: blur(55px) saturate(1.2); opacity: .55; transform: scale(1.15); }
  .shade { position: fixed; inset: 0; background: linear-gradient(180deg,rgba(10,10,12,.32),rgba(10,10,12,.82)); }
  main { position: relative; display: flex; height: 100vh; flex-direction: column; padding: 24px 26px 30px; }
  header { display: grid; grid-template-columns: 48px minmax(0,1fr); align-items: center; gap: 12px; }
  .cover { width: 48px; height: 48px; border-radius: 14px; object-fit: cover; background: rgba(255,255,255,.1); box-shadow: 0 10px 30px rgba(0,0,0,.3); }
  .copy { min-width: 0; }
  h1,p { overflow: hidden; margin: 0; text-overflow: ellipsis; white-space: nowrap; }
  h1 { font-size: 15px; letter-spacing: -.02em; }
  p { margin-top: 4px; color: rgba(255,255,255,.56); font-size: 12px; }
  .lyrics { display: flex; min-height: 0; flex: 1; flex-direction: column; justify-content: center; padding-top: 18px; }
  .lyrics-lines { display: flex; min-height: 0; flex-direction: column; justify-content: center; gap: 13px; }
  .line { color: rgba(255,255,255,.27); font-size: clamp(21px,5.4vw,31px); font-weight: 690; line-height: 1.16; letter-spacing: -.035em; transition: opacity .45s ease,color .45s ease,text-shadow .45s ease; }
  .line.active { color: #fff; text-shadow: 0 0 20px rgba(255,255,255,.18); }
  .translation { display: block; margin-top: .2em; font-size: .68em; opacity: .72; }
  .state { margin: auto 0; color: rgba(255,255,255,.5); font-size: 18px; font-weight: 620; }
`

const POPUP_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meliora 歌词</title><style>${popupStyles}</style></head><body><div class="background"></div><div class="shade"></div><main><header><img class="cover" alt=""><div class="copy"><h1></h1><p></p></div></header><section class="lyrics"><div class="state"></div><div class="lyrics-lines"></div></section></main></body></html>`

const CLOSED_POLL_INTERVAL = 800

// Safari 在窗口销毁后访问 closed 属性可能抛错,统一用 try/catch 兜底
function isWindowClosed(target: Window): boolean {
  try {
    return target.closed
  } catch {
    return true
  }
}

export function useLyricsWindow({ currentTrack, isPlaying }: LyricsWindowOptions) {
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

  function setSnapshot(value: LyricsSnapshot) {
    snapshot.value = value
    render()
  }

  function clearCache() {
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
    const lyricsContainer = target.document.querySelector<HTMLElement>('.lyrics-lines')
    const state = target.document.querySelector<HTMLElement>('.state')

    if (cover && title && artist && background && lyricsContainer && state) {
      cachedNodes = {
        cover,
        title,
        artist,
        background,
        lyricsContainer,
        state,
        lineNodes: [],
        translationNodes: [],
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
  }

  function ensureLineNode(index: number, doc: Document): HTMLDivElement {
    const nodes = cachedNodes!
    let node = nodes.lineNodes[index]
    if (!node) {
      node = doc.createElement('div')
      nodes.lineNodes[index] = node
      nodes.translationNodes[index] = null
    }
    return node
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

    const nextCover = track?.cover || new URL('favicon.svg', window.location.href).href
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
      for (let i = 0; i < lineNodes.length; i += 1) {
        const node = lineNodes[i]
        if (node && node.parentNode) node.remove()
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
    const hasActiveLine = active >= 0 && active < lines.length
    const start = hasActiveLine ? Math.max(0, active - 1) : 0
    const end = hasActiveLine ? Math.min(lines.length, active + 3) : Math.min(lines.length, 4)
    const visibleCount = end - start

    for (let slot = 0; slot < visibleCount; slot += 1) {
      const lineIndex = start + slot
      const line = lines[lineIndex]!
      const node = ensureLineNode(slot, doc)

      const positionClass = !hasActiveLine
        ? 'after'
        : lineIndex === active
          ? 'active'
          : lineIndex < active
            ? 'before'
            : 'after'
      const desiredClass = `line ${positionClass}`
      if (node.className !== desiredClass) node.className = desiredClass
      const indexStr = String(lineIndex)
      if (node.dataset.index !== indexStr) node.dataset.index = indexStr

      let translationNode = cachedNodes.translationNodes[slot]
      if (line.translation) {
        if (!translationNode) {
          translationNode = doc.createElement('span')
          translationNode.className = 'translation'
          cachedNodes.translationNodes[slot] = translationNode
        }
        if (node.firstChild !== node.lastChild || node.firstChild?.nodeType !== Node.TEXT_NODE) {
          node.textContent = line.text
        } else if (node.firstChild.nodeValue !== line.text) {
          node.firstChild.nodeValue = line.text
        }
        if (translationNode.textContent !== line.translation) {
          translationNode.textContent = line.translation
        }
        if (translationNode.parentNode !== node) {
          node.append(translationNode)
        }
      } else {
        if (translationNode && translationNode.parentNode) {
          translationNode.remove()
        }
        if (node.textContent !== line.text) {
          node.textContent = line.text
        }
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

    for (let slot = visibleCount; slot < lineNodes.length; slot += 1) {
      const node = lineNodes[slot]
      if (node && node.parentNode) node.remove()
    }
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
