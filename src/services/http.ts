// 服务层取远端数据的传输口。
//
// 默认是浏览器的 fetch。桌面端(Tauri)要走系统 HTTP 才能绕开 CORS,启动时换掉这一个
// 函数即可,曲库适配器与歌词服务都不用改。歌词文本另有自己的注入口
// (services/lyrics 的 setLyricsTextFetcher),因为它还叠了一层缓存与去重。

/** 请求选项刻意只留可移植的几项:缓存策略与取消信号,别的平台也都有对应概念 */
export interface HttpRequestInit {
  signal?: AbortSignal
  /** 与 fetch 的 cache 同义。不支持的平台可以忽略 */
  cache?: 'default' | 'force-cache' | 'no-store' | 'reload'
}

export type HttpFetcher = (url: string, init?: HttpRequestInit) => Promise<Response>

const browserFetch: HttpFetcher = (url, init) => fetch(url, init)

let current: HttpFetcher = browserFetch

export function httpFetch(url: string, init?: HttpRequestInit): Promise<Response> {
  return current(url, init)
}

/** 替换传输实现。传 null 恢复为浏览器的 fetch */
export function setHttpFetcher(fetcher: HttpFetcher | null): void {
  current = fetcher ?? browserFetch
}
