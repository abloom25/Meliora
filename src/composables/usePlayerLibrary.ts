import { computed, onBeforeUnmount, ref } from 'vue'
import { usePlayerStore } from '../stores/player'
import { musicConfig } from '../config/music'
import { loadConfiguredTracks, loadMusicConfig } from '../services/music'
import { filterTracks, trackMatchesShareId } from '../core/library/tracks'
import { applySiteIntegrations } from '../platform/web/site-integrations'
import type { PublicMusicConfig } from '../../shared/music-config'

/** 曲库加载、分享定位和站点配置应用；只有最新请求可以提交结果。 */
export function usePlayerLibrary(options: {
  showNotice: (message: string) => void
  clearNotice: () => void
}) {
  const { showNotice, clearNotice } = options
  const store = usePlayerStore()
  const runtimeConfig = ref<PublicMusicConfig>(musicConfig())
  const query = ref('')
  const loading = ref(true)
  const loadFailed = ref(false)
  const sourceWarning = ref('')
  const filteredTracks = computed(() => filterTracks(store.tracks, query.value))

  function resolveSiteIcon(icon: string | undefined): string {
    if (!icon) return `${import.meta.env.BASE_URL}favicon.svg`
    if (/^(https?:|data:|blob:)/i.test(icon)) return icon
    const base = new URL(import.meta.env.BASE_URL, window.location.origin)
    return new URL(icon, base).href
  }

  function applySiteBrand(config: PublicMusicConfig) {
    document.title = `${config.siteName} · Music Player`
    const iconHref = resolveSiteIcon(config.siteIcon)
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']")
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.href = iconHref
  }

  let loadTracksRequestId = 0
  onBeforeUnmount(() => {
    loadTracksRequestId += 1
  })

  async function loadTracks() {
    // 并发防护:onMounted 与 TrackList 的 @reload(连点重试)可能并发触发,
    // 用单调递增的请求序号保证只有最新一次的结果落地,
    // 避免后完成的旧响应覆盖 曲库/加载状态/错误提示 等新状态。
    const requestId = ++loadTracksRequestId
    loading.value = true
    sourceWarning.value = ''
    loadFailed.value = false
    clearNotice()
    try {
      const config = loadMusicConfig()
      runtimeConfig.value = config
      applySiteBrand(config)
      applySiteIntegrations(config)
      const result = await loadConfiguredTracks(config)
      if (requestId !== loadTracksRequestId) return
      store.setTracks(result.tracks)
      const url = new URL(window.location.href)
      const sharedTrackId = url.searchParams.get('share')
      const sharedTrack = sharedTrackId
        ? store.tracks.find((track) => trackMatchesShareId(track, sharedTrackId))
        : null
      if (sharedTrack) store.selectTrack(sharedTrack, store.tracks)
      if (sharedTrackId) {
        url.searchParams.delete('share')
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`)
      }
      loadFailed.value = !result.tracks.length && result.failedSources > 0
      if (result.failedSources) {
        sourceWarning.value = `${result.failedSources} 个音乐源暂时无法载入`
        showNotice(
          loadFailed.value ? '音乐源加载失败,请检查接口或在曲库中重试' : sourceWarning.value,
        )
      } else if (!result.tracks.length) {
        showNotice('暂无可播放歌曲,请在管理后台添加音乐')
      }
    } catch {
      if (requestId !== loadTracksRequestId) return
      loadFailed.value = true
      showNotice('音乐列表载入失败,请稍后重试')
    } finally {
      // 只有最新一次请求才允许复位 loading;过期请求的 finally 不得触碰新请求的状态
      if (requestId === loadTracksRequestId) loading.value = false
    }
  }

  return { runtimeConfig, query, loading, loadFailed, sourceWarning, filteredTracks, loadTracks }
}
