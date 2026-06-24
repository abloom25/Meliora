// 浏览器能力检测工具:集中管理 Safari 等浏览器的兼容性差异。
// 优先使用能力检测(feature detection),仅在无法用能力检测区分时才回退到 UA 嗅探。

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
  webkitIsFullScreen?: boolean
}

type WebkitHTMLElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
}

type WebkitWindow = Window & {
  webkitAudioContext?: typeof AudioContext
}

export interface FullscreenAPI {
  requestFullscreen: (el: HTMLElement) => Promise<void> | void
  exitFullscreen: () => Promise<void> | void
  getFullscreenElement: () => Element | null
  isFullscreen: () => boolean
  eventName: string
  supported: boolean
}

let cachedFullscreenAPI: FullscreenAPI | null = null

export function getFullscreenAPI(): FullscreenAPI {
  if (cachedFullscreenAPI) return cachedFullscreenAPI

  const doc = document as WebkitDocument
  const standardSupported =
    typeof document.fullscreenElement !== 'undefined' ||
    typeof document.exitFullscreen === 'function'

  if (standardSupported) {
    const api: FullscreenAPI = {
      supported: true,
      eventName: 'fullscreenchange',
      requestFullscreen: (el: HTMLElement) => el.requestFullscreen(),
      exitFullscreen: () => document.exitFullscreen(),
      getFullscreenElement: () => document.fullscreenElement,
      isFullscreen: () => Boolean(document.fullscreenElement),
    }
    cachedFullscreenAPI = api
    return api
  }

  // Safari 14- 及部分 WebKit 内核需要 webkit 前缀
  if (typeof doc.webkitFullscreenElement !== 'undefined' || doc.webkitExitFullscreen) {
    const api: FullscreenAPI = {
      supported: true,
      eventName: 'webkitfullscreenchange',
      requestFullscreen: (el: HTMLElement) => {
        const webkitEl = el as WebkitHTMLElement
        if (webkitEl.webkitRequestFullscreen) return webkitEl.webkitRequestFullscreen()
      },
      exitFullscreen: () => {
        if (doc.webkitExitFullscreen) return doc.webkitExitFullscreen()
      },
      getFullscreenElement: () => doc.webkitFullscreenElement ?? null,
      isFullscreen: () => Boolean(doc.webkitFullscreenElement) || doc.webkitIsFullScreen === true,
    }
    cachedFullscreenAPI = api
    return api
  }

  // iOS Safari 完全不支持 Fullscreen API(仅 PWA 模式可用)
  const unsupported: FullscreenAPI = {
    supported: false,
    eventName: 'fullscreenchange',
    requestFullscreen: () => undefined,
    exitFullscreen: () => undefined,
    getFullscreenElement: () => null,
    isFullscreen: () => false,
  }
  cachedFullscreenAPI = unsupported
  return unsupported
}

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>
}

export function supportsDocumentPictureInPicture(): boolean {
  if (typeof window === 'undefined') return false
  const dpip = (window as Window & { documentPictureInPicture?: DocumentPictureInPicture })
    .documentPictureInPicture
  return typeof dpip?.requestWindow === 'function'
}

export function createAudioContextCompatible(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const win = window as WebkitWindow
  const Ctor = window.AudioContext ?? win.webkitAudioContext
  if (!Ctor) return null
  try {
    return new Ctor()
  } catch {
    return null
  }
}

export function supportsWebAnimations(): boolean {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'
}

// iOS Safari 检测:iPadOS 13+ 默认请求桌面 UA,需要结合 platform + maxTouchPoints 判断
export function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const platform = navigator.platform
  const touchPoints = navigator.maxTouchPoints || 0
  // iPhone / iPod / 旧 iPad 直接通过 UA 判断
  if (/iPhone|iPad|iPod/i.test(ua)) return true
  // iPadOS 13+ 桌面 UA:platform 仍是 MacIntel 但有多点触控
  if (platform === 'MacIntel' && touchPoints > 1) return true
  return false
}

// Safari 浏览器检测(含 iPadOS 桌面模式)。优先用能力检测,仅在需要 UA 区分时使用。
export function isSafariBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  // Chrome/Edge/Brave 等 Chromium 内核 UA 中也包含 Safari 字样,需要先排除
  if (/CriOS|FxiOS|EdgiOS|Edg\/|Chrome\/|Chromium/i.test(ua)) return false
  // iOS 上 Chrome/Edge/Firefox 都是 Safari WebView 包装,CriOS/FxiOS/EdgiOS 已排除,剩下的是 Safari
  if (isIOSDevice()) return true
  // macOS Safari:含 Safari 但不含 Chrome/Chromium 等
  return /Safari/i.test(ua) && !/Chrome/i.test(ua)
}

// iOS Safari 不支持 Fullscreen API(即使在桌面模式添加到主屏幕也只有 minimal-ui)
export function isFullscreenUnsupportedByPlatform(): boolean {
  return isIOSDevice() && !getFullscreenAPI().supported
}

// iOS Safari 的 PWA 安装:不支持 beforeinstallprompt,需要引导用户手动"添加到主屏幕"
export function canShowIosInstallGuide(): boolean {
  if (!isIOSDevice()) return false
  // 已独立运行(已添加到主屏幕)则不需要再引导
  const nav = navigator as Navigator & { standalone?: boolean }
  if (nav.standalone === true) return false
  // display-mode: standalone 表示已在 PWA 模式运行
  if (window.matchMedia('(display-mode: standalone)').matches) return false
  return true
}
