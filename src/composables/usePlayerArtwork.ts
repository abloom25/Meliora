import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { Track, PlayerSettings } from '../core/types'
import { extractThemeColor, type ThemeColor } from '../platform/web/theme'
import { useThemeAccent } from './useThemeAccent'
import { useCoverCache } from './useCoverCache'

/** 主封面的解码、CORS 回退与主题色生命周期。 */
export function usePlayerArtwork(
  currentTrack: Readonly<Ref<Track | null>>,
  settings: Readonly<Ref<PlayerSettings>>,
) {
  let disposed = false
  onBeforeUnmount(() => {
    disposed = true
  })

  // Theme accent composable
  const { accent, accentSoft, accentRgb, applyTheme, resetTheme, cssTransitionSupported } =
    useThemeAccent()

  // Cover cache composable (singleton)
  const {
    loadedCovers,
    failedCovers,
    mainCoverReadyTrackId,
    markCoverLoaded,
    markCoverFailed,
    markMainCoverReady,
    resetMainCover,
  } = useCoverCache()

  // 封面 CORS 回退:crossorigin="anonymous" 首次加载失败(CDN 不返回 CORS 头)时,
  // 移除 crossorigin 重新加载,保证封面显示(取色降级为默认色)。
  // 用 trackId + cover URL 持久记录已回退项,避免回切同一首歌时重复发起一次必失败的 CORS 请求。
  const coverCorsRetry = ref(new Set<string>())
  const backgroundImage = computed(() => {
    const track = currentTrack.value
    if (!settings.value.dynamicBackground || !track?.cover || failedCovers.value.has(track.id)) {
      return 'none'
    }
    // CSS url("...") 字符串需同时转义反斜杠与双引号,且顺序不能反:
    // 只转义引号时,URL 里的反斜杠会吞掉闭合引号,导致整条声明失效甚至解析异常。
    const escapedCover = track.cover.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    return `url("${escapedCover}")`
  })
  const mainCoverItems = computed(() => {
    const track = currentTrack.value
    if (!track?.cover || failedCovers.value.has(track.id)) return []
    const corsKey = coverRetryKey(track.id, track.cover)
    const corsRetried = coverCorsRetry.value.has(corsKey)
    return [
      {
        id: track.id,
        title: track.title,
        cover: track.cover,
        corsKey,
        corsRetried,
        key: `${corsKey}-${corsRetried}`,
      },
    ]
  })
  async function handleMainCoverLoaded(trackId: string, event: Event) {
    const image = event.currentTarget as HTMLImageElement
    // 等图片完整解码完成后再标记 loaded：
    // 避免浏览器渲染半解码的图像（视觉上"从上往下"逐行加载的效果），
    // 让 fade-in transition 真正发生在一张完整图像上。
    try {
      await image.decode?.()
    } catch {
      // 部分浏览器对跨域 / data URL 图片会拒绝 decode()，
      // 图片可能未完整解码，此时提取的主题色不可靠，直接回退到默认色。
      if (!disposed && currentTrack.value?.id === trackId) {
        markCoverLoaded(trackId)
        markMainCoverReady(trackId)
        resetTheme()
      }
      return
    }
    if (disposed || currentTrack.value?.id !== trackId) return
    markCoverLoaded(trackId)
    markMainCoverReady(trackId)
    // extractThemeColor 现在是 async（Worker 化）；直接 await 即可。
    // 如果 Worker 路径成功就返回新主题色；失败时内部已自动 fallback 到主线程 + null 兜底。
    let immediateTheme: ThemeColor | null
    try {
      immediateTheme = await extractThemeColor(image)
    } catch {
      immediateTheme = null
    }
    if (disposed || currentTrack.value?.id !== trackId) return
    if (!immediateTheme) {
      resetTheme()
      return
    }
    applyTheme(immediateTheme)
  }

  function coverRetryKey(trackId: string, cover: string) {
    return `${trackId}\n${cover}`
  }

  function rememberCoverCorsRetry(corsKey: string) {
    const next = new Set(coverCorsRetry.value)
    if (next.has(corsKey)) next.delete(corsKey)
    next.add(corsKey)
    while (next.size > 512) {
      const oldest = next.values().next().value
      if (!oldest) break
      next.delete(oldest)
    }
    coverCorsRetry.value = next
  }

  function handleMainCoverError(trackId: string, corsKey: string) {
    // crossorigin="anonymous" 模式下,CDN 不返回 Access-Control-Allow-Origin 会触发 onerror。
    // 首次失败时回退:标记该 trackId 并通过 :key 变化重建 <img>(移除 crossorigin),
    // 保证封面显示;此时取色因 canvas 污染降级为默认色。
    // 已回退过仍失败说明资源本身不可用,走正常的 failedCovers 标记流程。
    if (!coverCorsRetry.value.has(corsKey)) {
      rememberCoverCorsRetry(corsKey)
      return
    }
    markCoverFailed(trackId)
  }

  watch(
    () => currentTrack.value?.id,
    () => {
      resetMainCover()
      if (!currentTrack.value?.cover) resetTheme()
    },
    { flush: 'sync' },
  )

  return {
    accent,
    accentSoft,
    accentRgb,
    cssTransitionSupported,
    loadedCovers,
    failedCovers,
    markCoverLoaded,
    markCoverFailed,
    mainCoverReadyTrackId,
    backgroundImage,
    mainCoverItems,
    handleMainCoverLoaded,
    handleMainCoverError,
  }
}
