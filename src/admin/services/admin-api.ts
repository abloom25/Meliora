import type { MusicConfig } from '../../types/music'
import { validateMusicConfig } from '../../../shared/config-schema'
import { fetchWithCsrf, csrfManager } from '../utils/csrf'
import { UPLOAD_LIMITS } from '../../../shared/constants'
import { getPlaybackSupportError } from '../../../shared/playback-support'

export interface SaveResult {
  ok: boolean
  error?: string
  warning?: string
  message?: string
  triggeredAt?: string
  triggerId?: string
}

export interface UploadResult {
  ok: boolean
  blobSha?: string
  path?: string
  local?: boolean
  error?: string
}

export interface StagedUpload {
  path: string
  blobSha: string
}

export const MAX_UPLOAD_BYTES = UPLOAD_LIMITS.MAX_BYTES
export const MAX_UPLOAD_BASE64_LENGTH = UPLOAD_LIMITS.MAX_BASE64_LENGTH
export const MAX_UPLOAD_SIZE_LABEL = UPLOAD_LIMITS.MAX_SIZE_LABEL

interface ApiErrorPayload {
  error?: string
  detail?: string
  details?: string[]
  message?: string
}

type AdminRequestResult<T> =
  | { ok: true; data: T }
  | { ok: false; data: Partial<T> & ApiErrorPayload; error: string }

export interface ApiPlaylistCheck {
  server: string
  playlistId: string
  ok: boolean
  status?: number
  trackCount: number
  error?: string
}

export interface MusicApiTestResult {
  ok: boolean
  playlistCount: number
  failedPlaylists: number
  trackCount: number
  playlists: ApiPlaylistCheck[]
}

export interface UpdateInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  targetTag?: string
  releaseNotes: string
  releaseUrl: string
  publishedAt: string
}

export interface UpdateRunInfo {
  id: number
  runNumber: number
  runAttempt: number
  event: string
  branch: string
  status: string
  conclusion: string | null
  displayStatus:
    | 'locating'
    | 'queued'
    | 'running'
    | 'success'
    | 'failed'
    | 'cancelled'
    | 'timed_out'
    | 'unknown'
  createdAt: string
  updatedAt: string
  startedAt?: string
  htmlUrl: string
  latestCommitSha?: string
  latestCommitUrl?: string
}

export interface UpdateStatusInfo {
  ok: boolean
  run: UpdateRunInfo | null
  failure?: {
    message: string
    conclusion?: string
  }
  message: string
  retryAfterSeconds?: number
}

export interface AdminApiDependencies {
  onUnauthenticated?: () => void
}

export function createAdminApi(dependencies: AdminApiDependencies = {}) {
  function resolveErrorMessage(data: ApiErrorPayload, fallback: string): string {
    return data.details?.join('; ') || data.detail || data.error || data.message || fallback
  }

  async function requestAdminJson<T extends object>(
    url: string,
    init: RequestInit,
    options: {
      fallbackError: string
      abortedError?: string
      markUnauthenticated?: boolean
      /**
       * 非幂等请求(如触发部署)置为 false。
       * 重试安全的前提:服务端的 403 只发生在 CSRF/跨站校验阶段(见 server/core/router.ts),
       * 此时业务 handler 尚未执行、没有任何副作用;幂等请求重试一次是安全的。
       */
      retryOn403?: boolean
    },
  ): Promise<AdminRequestResult<T>> {
    try {
      let response = await fetchWithCsrf(url, { ...init, credentials: 'include' })
      let data = (await response.json().catch(() => ({}))) as Partial<T> & ApiErrorPayload

      // 403 多为 CSRF token 失效(如改密码 bump 版本后旧 token 被吊销):
      // 清除内存 token 并重试一次,fetchWithCsrf 会在重试前自动重新获取 token。
      // 已 abort 的请求不重试:复用的 init.signal 已中止,重试会立刻 AbortError,
      // 把真实错误误报成"已取消"。
      if (response.status === 403 && options.retryOn403 !== false && !init.signal?.aborted) {
        csrfManager.clearToken()
        response = await fetchWithCsrf(url, { ...init, credentials: 'include' })
        data = (await response.json().catch(() => ({}))) as Partial<T> & ApiErrorPayload
      }

      if (response.ok) return { ok: true, data: data as T }

      // 仅 401 视为登录过期;403 重试仍失败时按服务端返回的错误提示
      if (response.status === 401 && options.markUnauthenticated !== false) {
        dependencies.onUnauthenticated?.()
        return { ok: false, data, error: '登录已过期,请重新登录' }
      }

      return {
        ok: false,
        data,
        error: resolveErrorMessage(data, options.fallbackError),
      }
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === 'AbortError'
          ? options.abortedError || '请求已取消'
          : '网络错误'
      return { ok: false, data: {}, error: message }
    }
  }

  async function fetchConfig(): Promise<MusicConfig | null> {
    const result = await requestAdminJson<MusicConfig>(
      '/api/config',
      {},
      { fallbackError: '配置加载失败' },
    )
    return result.ok ? result.data : null
  }

  async function saveConfig(
    config: MusicConfig,
    uploads: StagedUpload[] = [],
  ): Promise<SaveResult> {
    // 与服务端开发模式一致(server/core/config-handler.ts):
    // dev 下允许 http://localhost 等私网地址,避免前端误拦
    const validation = validateMusicConfig(config, { allowPrivateUrls: import.meta.env.DEV })
    if (!validation.valid) {
      return { ok: false, error: validation.errors.join('; ') }
    }

    const playbackError = getPlaybackSupportError(validation.config!)
    if (playbackError) return { ok: false, error: playbackError }

    const result = await requestAdminJson<{ sha?: string }>(
      '/api/config',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config, uploads }),
      },
      { fallbackError: '保存失败' },
    )
    if (!result.ok) return { ok: false, error: result.error }

    if (import.meta.env.DEV) {
      const synced = await syncLocalGeneratedConfig(config)
      if (!synced.ok) {
        return {
          ok: true,
          warning: `后端配置已保存,但本地播放器配置同步失败:${synced.error || '未知错误'}`,
        }
      }
    }
    return { ok: true }
  }

  async function syncLocalGeneratedConfig(
    config: MusicConfig,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await fetch('/__meliora-dev/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string
          details?: string[]
        }
        return { ok: false, error: data.details?.join('; ') || data.error || '同步失败' }
      }
      return { ok: true }
    } catch {
      return { ok: false, error: '同步接口不可用' }
    }
  }

  async function uploadFile(path: string, content: string): Promise<UploadResult> {
    if (content.length > MAX_UPLOAD_BASE64_LENGTH) {
      return { ok: false, error: `文件过大,最大 ${MAX_UPLOAD_SIZE_LABEL}` }
    }

    const result = await requestAdminJson<{ blobSha?: string; path?: string; local?: boolean }>(
      '/api/upload',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content }),
      },
      { fallbackError: '上传失败' },
    )
    if (!result.ok) return { ok: false, error: result.error }
    if (!result.data.blobSha || !result.data.path) {
      return { ok: false, error: '暂存响应不完整,文件未加入待保存列表' }
    }
    return {
      ok: true,
      blobSha: result.data.blobSha,
      path: result.data.path,
      local: result.data.local,
    }
  }

  async function changePassword(current: string, next: string): Promise<SaveResult> {
    const result = await requestAdminJson<{ success?: boolean }>(
      '/api/change-password',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current, next }),
      },
      { fallbackError: '修改失败' },
    )
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  }

  async function testMusicApi(
    config: MusicConfig,
  ): Promise<{ ok: boolean; data?: MusicApiTestResult; error?: string }> {
    const validation = validateMusicConfig(config)
    if (!validation.valid) return { ok: false, error: validation.errors.join('; ') }
    const playbackError = getPlaybackSupportError(validation.config!)
    if (playbackError) return { ok: false, error: playbackError }

    const result = await requestAdminJson<MusicApiTestResult>(
      '/api/test-music-api',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      },
      { fallbackError: '测试失败' },
    )
    if (!result.ok) return { ok: false, error: result.error }
    return {
      ok: result.data.ok,
      data: result.data,
      error: result.data.ok ? undefined : '部分资源测试失败',
    }
  }

  async function checkUpdate(
    currentVersion: string,
    githubProxy?: string,
    receivePrereleaseUpdates = false,
    signal?: AbortSignal,
    options: { markUnauthenticated?: boolean } = {},
  ): Promise<{ ok: boolean; data?: UpdateInfo; error?: string }> {
    const result = await requestAdminJson<UpdateInfo>(
      '/api/check-update',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current: currentVersion,
          githubProxy: githubProxy?.trim() || '',
          receivePrereleaseUpdates,
        }),
        signal,
      },
      {
        fallbackError: '检查失败',
        abortedError: '检查已取消',
        markUnauthenticated: options.markUnauthenticated,
      },
    )
    return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error }
  }

  async function triggerUpdate(
    githubProxy?: string,
    targetTag?: string,
    receivePrereleaseUpdates = false,
  ): Promise<SaveResult> {
    const result = await requestAdminJson<{
      message?: string
      triggeredAt?: string
      triggerId?: string
    }>(
      '/api/update',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubProxy: githubProxy?.trim() || '',
          targetTag: targetTag?.trim() || '',
          receivePrereleaseUpdates,
        }),
      },
      { fallbackError: '触发失败', retryOn403: false },
    )
    if (!result.ok) return { ok: false, error: result.error }
    return {
      ok: true,
      message: result.data.message,
      triggeredAt: result.data.triggeredAt,
      triggerId: result.data.triggerId,
    }
  }

  async function fetchUpdateStatus(
    since?: string,
    triggerId?: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; data?: UpdateStatusInfo; error?: string }> {
    const params = new URLSearchParams()
    if (since) params.set('since', since)
    if (triggerId) params.set('triggerId', triggerId)
    const query = params.toString()
    const result = await requestAdminJson<UpdateStatusInfo>(
      `/api/update/status${query ? `?${query}` : ''}`,
      { signal },
      { fallbackError: '获取更新状态失败', abortedError: '状态查询已取消' },
    )
    return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error }
  }
  return {
    fetchConfig,
    saveConfig,
    uploadFile,
    changePassword,
    testMusicApi,
    checkUpdate,
    triggerUpdate,
    fetchUpdateStatus,
  }
}

export const {
  fetchConfig,
  saveConfig,
  uploadFile,
  changePassword,
  testMusicApi,
  checkUpdate,
  triggerUpdate,
  fetchUpdateStatus,
} = createAdminApi()
