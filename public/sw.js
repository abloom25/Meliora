/* global self, caches, fetch, URL, Response */

const CACHE_NAME = '__SW_CACHE_NAME__'
const CACHE_PREFIX = 'meliora-shell-'
const APP_SHELL = ['./', './manifest.webmanifest', './favicon.svg', './pwa-icon.svg']
const MUTABLE_ASSET_PATTERN = /^\/(?:music\/|icon\.(?:png|jpe?g|webp|ico)$)/i

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  // 对带 Range 头的请求（通常用于音视频分段加载）直接放行，避免 SW 缓存层破坏 206 响应
  // 使用 lowercase 遍历避免 HTTP header 名大小写不敏感问题（RFC 9110）
  const rangeHeader = event.request.headers.get('range')
  if (rangeHeader && rangeHeader.trim().length > 0) return
  // 对音频与视频资源直接放行，交由浏览器默认处理，确保流式与 seek 行为正常
  if (event.request.destination === 'audio' || event.request.destination === 'video') return

  if (event.request.method !== 'GET') return
  const requestUrl = new URL(event.request.url)
  if (requestUrl.origin !== self.location.origin) return
  // API 请求(鉴权、配置等动态数据)必须始终走网络,禁止缓存。
  // 缓存优先策略会让退出登录后的 /api/auth 仍返回旧的 { authenticated: true },
  // 刷新页面后重新进入已登录态,导致退出登录在生产环境失效。
  if (requestUrl.pathname.startsWith('/api/')) return
  // 后台上传的图标、封面和本地音乐使用稳定 URL。它们不是 Vite hash 资源,
  // 缓存优先会让用户替换文件后仍看到旧内容,所以直接交给网络和浏览器缓存策略。
  if (MUTABLE_ASSET_PATTERN.test(requestUrl.pathname)) return
  // 非构建产物图片也经常使用稳定 URL(例如 /covers/foo.jpg)。这些图片数量可能随歌单增长,
  // 不进入 SW Cache Storage,避免大歌单滚动/切歌后长期积累上千张封面。
  if (event.request.destination === 'image' && !requestUrl.pathname.startsWith('/assets/')) return

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put('./', copy))
          return response
        })
        .catch(() => caches.match('./')),
    )
    return
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy))
        }
        return response
      })
      return (
        cached ||
        network.catch(() =>
          caches
            .match(event.request)
            .then((res) => res || new Response('', { status: 504, statusText: 'Gateway Timeout' })),
        )
      )
    }),
  )
})
