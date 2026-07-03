import type { MusicConfig } from '../../types/music'
import { validateMusicConfig } from '../../../shared/config-schema'
import { markAdminUnauthenticated } from '../composables/useAdminAuth'

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
  sha?: string
  path?: string
  local?: boolean
  error?: string
}

export interface DeleteFileResult {
  path: string
  deleted: boolean
  error?: string
}

export interface DeleteFilesResult {
  ok: boolean
  results: DeleteFileResult[]
  error?: string
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
export const MAX_UPLOAD_BASE64_LENGTH = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4
export const MAX_UPLOAD_SIZE_LABEL = '25MB'

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

export async function fetchConfig(): Promise<MusicConfig | null> {
  try {
    const response = await fetch('/api/config', { credentials: 'include' })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        markAdminUnauthenticated()
      }
      return null
    }
    return (await response.json()) as MusicConfig
  } catch {
    return null
  }
}

function markUnauthenticatedResponse(response: Response): boolean {
  if (response.status !== 401 && response.status !== 403) return false
  markAdminUnauthenticated()
  return true
}

export async function saveConfig(config: MusicConfig): Promise<SaveResult> {
  const validation = validateMusicConfig(config)
  if (!validation.valid) {
    return { ok: false, error: validation.errors.join('; ') }
  }

  try {
    const response = await fetch('/api/config', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    if (!response.ok) {
      if (markUnauthenticatedResponse(response)) {
        return { ok: false, error: '登录已过期,请重新登录' }
      }
      const data = (await response.json().catch(() => ({}))) as {
        error?: string
        details?: string[]
      }
      return {
        ok: false,
        error: data.details?.join('; ') || data.error || '保存失败',
      }
    }
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
  } catch {
    return { ok: false, error: '网络错误' }
  }
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

export async function uploadFile(path: string, content: string): Promise<UploadResult> {
  try {
    if (content.length > MAX_UPLOAD_BASE64_LENGTH) {
      return { ok: false, error: `文件过大,最大 ${MAX_UPLOAD_SIZE_LABEL}` }
    }

    const response = await fetch('/api/upload', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    })
    if (!response.ok) {
      if (markUnauthenticatedResponse(response)) {
        return { ok: false, error: '登录已过期,请重新登录' }
      }
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      return { ok: false, error: data.error || '上传失败' }
    }
    const data = (await response.json()) as { sha?: string; path?: string; local?: boolean }
    return { ok: true, sha: data.sha, path: data.path, local: data.local }
  } catch {
    return { ok: false, error: '网络错误' }
  }
}

export async function deleteFiles(paths: string[]): Promise<DeleteFilesResult> {
  if (paths.length === 0) return { ok: true, results: [] }

  try {
    const response = await fetch('/api/file', {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
    const data = (await response.json().catch(() => ({}))) as {
      error?: string
      results?: DeleteFileResult[]
    }
    const results = Array.isArray(data.results) ? data.results : []
    const failed = results.filter((item) => !item.deleted)

    if (!response.ok) {
      if (markUnauthenticatedResponse(response)) {
        return { ok: false, results, error: '登录已过期,请重新登录' }
      }
      return { ok: false, results, error: data.error || '删除失败' }
    }

    if (results.length !== paths.length) {
      return { ok: false, results, error: '删除结果数量异常,请刷新后重试' }
    }

    if (failed.length > 0) {
      return {
        ok: false,
        results,
        error: `部分文件删除失败: ${failed.map((item) => item.path).join(', ')}`,
      }
    }

    return { ok: true, results }
  } catch {
    return { ok: false, results: [], error: '网络错误' }
  }
}

export async function changePassword(current: string, next: string): Promise<SaveResult> {
  try {
    const response = await fetch('/api/change-password', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current, next }),
    })
    if (!response.ok) {
      if (markUnauthenticatedResponse(response)) {
        return { ok: false, error: '登录已过期,请重新登录' }
      }
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      return { ok: false, error: data.error || '修改失败' }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: '网络错误' }
  }
}

export async function testMusicApi(
  config: MusicConfig,
): Promise<{ ok: boolean; data?: MusicApiTestResult; error?: string }> {
  try {
    const response = await fetch('/api/test-music-api', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    if (!response.ok) {
      if (markUnauthenticatedResponse(response)) {
        return { ok: false, error: '登录已过期,请重新登录' }
      }
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      return { ok: false, error: data.error || '测试失败' }
    }
    const data = (await response.json()) as MusicApiTestResult
    return { ok: data.ok, data, error: data.ok ? undefined : '部分资源测试失败' }
  } catch {
    return { ok: false, error: '网络错误' }
  }
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

export async function checkUpdate(
  currentVersion: string,
  githubProxy?: string,
  receivePrereleaseUpdates = false,
  signal?: AbortSignal,
  options: { markUnauthenticated?: boolean } = {},
): Promise<{ ok: boolean; data?: UpdateInfo; error?: string }> {
  try {
    const response = await fetch('/api/check-update', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        current: currentVersion,
        githubProxy: githubProxy?.trim() || '',
        receivePrereleaseUpdates,
      }),
      signal,
    })
    if (!response.ok) {
      if (options.markUnauthenticated !== false && markUnauthenticatedResponse(response)) {
        return { ok: false, error: '登录已过期,请重新登录' }
      }
      const data = (await response.json().catch(() => ({}))) as { error?: string; detail?: string }
      return { ok: false, error: data.detail || data.error || '检查失败' }
    }
    const data = (await response.json()) as UpdateInfo
    return { ok: true, data }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { ok: false, error: '检查已取消' }
    }
    return { ok: false, error: '网络错误' }
  }
}

export async function triggerUpdate(
  githubProxy?: string,
  targetTag?: string,
  receivePrereleaseUpdates = false,
): Promise<SaveResult> {
  try {
    const response = await fetch('/api/update', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        githubProxy: githubProxy?.trim() || '',
        targetTag: targetTag?.trim() || '',
        receivePrereleaseUpdates,
      }),
    })
    if (!response.ok) {
      if (markUnauthenticatedResponse(response)) {
        return { ok: false, error: '登录已过期,请重新登录' }
      }
      const data = (await response.json().catch(() => ({}))) as { error?: string; detail?: string }
      return { ok: false, error: data.detail || data.error || '触发失败' }
    }
    const data = (await response.json().catch(() => ({}))) as {
      message?: string
      triggeredAt?: string
      triggerId?: string
    }
    return {
      ok: true,
      message: data.message,
      triggeredAt: data.triggeredAt,
      triggerId: data.triggerId,
    }
  } catch {
    return { ok: false, error: '网络错误' }
  }
}

export async function fetchUpdateStatus(
  since?: string,
  triggerId?: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; data?: UpdateStatusInfo; error?: string }> {
  try {
    const params = new URLSearchParams()
    if (since) params.set('since', since)
    if (triggerId) params.set('triggerId', triggerId)
    const response = await fetch(`/api/update/status${params.toString() ? `?${params}` : ''}`, {
      credentials: 'include',
      signal,
    })
    if (!response.ok) {
      if (markUnauthenticatedResponse(response)) {
        return { ok: false, error: '登录已过期,请重新登录' }
      }
      const data = (await response.json().catch(() => ({}))) as {
        error?: string
        message?: string
        retryAfterSeconds?: number
      }
      return { ok: false, error: data.error || data.message || '获取更新状态失败' }
    }
    const data = (await response.json()) as UpdateStatusInfo
    return { ok: true, data }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { ok: false, error: '状态查询已取消' }
    }
    return { ok: false, error: '网络错误' }
  }
}
