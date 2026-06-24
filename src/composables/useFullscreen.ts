import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getFullscreenAPI, isFullscreenUnsupportedByPlatform } from '../utils/browser'

export interface UseFullscreenOptions {
  onShowNotice: (msg: string) => void
}

export function useFullscreen(options: UseFullscreenOptions) {
  const { onShowNotice } = options

  const fullscreenActive = ref(false)

  function isBrowserFullscreen() {
    const width = Math.max(window.screen.width, window.screen.availWidth)
    const height = Math.max(window.screen.height, window.screen.availHeight)
    return window.innerWidth >= width - 2 && window.innerHeight >= height - 2
  }

  function syncFullscreenState() {
    const api = getFullscreenAPI()
    fullscreenActive.value = api.isFullscreen() || isBrowserFullscreen()
  }

  async function toggleFullscreenMode() {
    const api = getFullscreenAPI()

    // iOS Safari 完全不支持 Fullscreen API,需要引导用户使用浏览器自带全屏
    if (!api.supported || isFullscreenUnsupportedByPlatform()) {
      if (isBrowserFullscreen()) {
        onShowNotice('请按 F11 或浏览器菜单退出全屏')
      } else {
        onShowNotice('当前设备暂不支持网页全屏,请使用浏览器菜单进入全屏')
      }
      syncFullscreenState()
      return
    }

    try {
      if (api.isFullscreen()) {
        await api.exitFullscreen()
        return
      }
      if (isBrowserFullscreen()) {
        onShowNotice('请按 F11 退出浏览器全屏')
        syncFullscreenState()
        return
      }
      await api.requestFullscreen(document.documentElement)
    } catch {
      onShowNotice('浏览器暂时无法进入全屏')
    } finally {
      syncFullscreenState()
    }
  }

  function handleFullscreenChange() {
    syncFullscreenState()
  }

  onMounted(() => {
    const api = getFullscreenAPI()
    document.addEventListener(api.eventName, handleFullscreenChange)
    // 标准事件也监听一遍,兼容部分浏览器同时支持两套事件的情况
    if (api.eventName !== 'fullscreenchange') {
      document.addEventListener('fullscreenchange', handleFullscreenChange)
    }
    window.addEventListener('resize', syncFullscreenState)
    window.visualViewport?.addEventListener('resize', syncFullscreenState)
    syncFullscreenState()
  })

  onBeforeUnmount(() => {
    const api = getFullscreenAPI()
    document.removeEventListener(api.eventName, handleFullscreenChange)
    if (api.eventName !== 'fullscreenchange') {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }
    window.removeEventListener('resize', syncFullscreenState)
    window.visualViewport?.removeEventListener('resize', syncFullscreenState)
  })

  return {
    fullscreenActive,
    isBrowserFullscreen,
    syncFullscreenState,
    toggleFullscreenMode,
  }
}
