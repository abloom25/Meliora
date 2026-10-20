// 服务层取远端数据的传输口。
//
// 默认是浏览器的 fetch。桌面端(Tauri)要走系统 HTTP 才能绕开 CORS,启动时换掉这一个
// 函数即可,曲库适配器与歌词服务都不用改。歌词文本另有自己的注入口
// (services/lyrics 的 setLyricsTextFetcher),因为它还叠了一层缓存与去重。

import {
  beginRuntimeHttp,
  hasRuntimeHttpObservers,
  runtimeResourceLabel,
} from '../core/diagnostics/runtime-debug'

/** 请求选项刻意只留可移植的几项:缓存策略与取消信号,别的平台也都有对应概念 */
export interface HttpRequestInit {
  signal?: AbortSignal
  /** 简单请求头也由传输实现透传，例如音频预分析的 Accept。 */
  headers?: Record<string, string>
  /** 与 fetch 的 cache 同义。不支持的平台可以忽略 */
  cache?: 'default' | 'force-cache' | 'no-cache' | 'no-store' | 'reload'
}

export type HttpFetcher = (url: string, init?: HttpRequestInit) => Promise<Response>

const browserFetch: HttpFetcher = (url, init) => fetch(url, init)

let current: HttpFetcher = browserFetch

export function httpFetch(url: string, init?: HttpRequestInit): Promise<Response> {
  const fetcher = current
  if (!hasRuntimeHttpObservers()) return fetcher(url, init)
  const finish = beginRuntimeHttp(runtimeResourceLabel(url), performance.now())
  // Retain only the cancellation signal and redacted token, never headers or body.
  const signal = init?.signal
  const failure = (error: unknown): void => {
    try {
      const cancelled = signal?.aborted || (error instanceof Error && error.name === 'AbortError')
      finish(cancelled ? 'cancelled' : 'failed', performance.now())
    } catch {
      // Observation must preserve the original result, including thrown transport errors.
    }
  }
  try {
    const pending = fetcher(url, init)
    void pending.then((response) => {
      try {
        finish(response.status >= 400 ? 'failed' : 'completed', performance.now(), response.status)
      } catch {
        // Optional diagnostics cannot reject a successful response or consume its body.
      }
    }, failure)
    return pending
  } catch (error) {
    failure(error)
    throw error
  }
}

/** 替换传输实现。传 null 恢复为浏览器的 fetch */
export function setHttpFetcher(fetcher: HttpFetcher | null): void {
  current = fetcher ?? browserFetch
}
