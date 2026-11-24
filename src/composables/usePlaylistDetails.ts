import { computed, shallowReactive, watch } from 'vue'
import type { MetingPlaylistConfig, PlaylistDetails } from '../../shared/music-config'
import { httpFetch } from '../services/http'

/** 平台资料单独加载；音轨和搜索不需要等封面接口。 */
export function usePlaylistDetails(source: () => readonly MetingPlaylistConfig[]) {
  const details = shallowReactive(new Map<string, PlaylistDetails>())
  const keys = computed(() =>
    [
      ...new Set(
        source()
          .filter((item) => /^\d{1,20}$/.test(item.playlistId.trim()))
          .map((item) => `${item.server}:${item.playlistId.trim()}`),
      ),
    ].join(','),
  )

  watch(
    keys,
    (value, _, onCleanup) => {
      const active = new Set(value ? value.split(',') : [])
      for (const key of details.keys()) if (!active.has(key)) details.delete(key)
      const pending = [...active].filter((key) => !details.has(key))
      if (!pending.length) return
      const controller = new AbortController()
      const jobs = pending.values()
      async function load() {
        for (const key of jobs) {
          if (controller.signal.aborted) return
          const [server, id] = key.split(':')
          try {
            const result = await httpFetch(`/api/playlist?server=${server}&id=${id}`, {
              signal: controller.signal,
            })
            if (!result.ok) continue
            const item = (await result.json()) as PlaylistDetails
            if (!controller.signal.aborted && typeof item?.name === 'string' && item.name.trim())
              details.set(key, item)
          } catch {
            // 离线或平台不可用时，继续用已有资料，也继续处理其余歌单。
          }
        }
      }
      const timer = setTimeout(() => {
        for (let i = 0; i < Math.min(3, pending.length); i++) void load()
      }, 250)
      onCleanup(() => {
        clearTimeout(timer)
        controller.abort()
      })
    },
    { immediate: true },
  )
  return details
}
