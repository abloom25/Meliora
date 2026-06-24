import type { MusicConfig } from '../../types/music'

export interface SaveResult {
  ok: boolean
  error?: string
  message?: string
}

export interface UploadResult {
  ok: boolean
  sha?: string
  path?: string
  local?: boolean
  error?: string
}

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
    if (!response.ok) return null
    return (await response.json()) as MusicConfig
  } catch {
    return null
  }
}

export async function saveConfig(config: MusicConfig): Promise<SaveResult> {
  try {
    const response = await fetch('/api/config', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        error?: string
        details?: string[]
      }
      return {
        ok: false,
        error: data.details?.join('; ') || data.error || '保存失败',
      }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: '网络错误' }
  }
}

export async function uploadFile(path: string, content: string): Promise<UploadResult> {
  try {
    const response = await fetch('/api/upload', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    })
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      return { ok: false, error: data.error || '上传失败' }
    }
    const data = (await response.json()) as { sha?: string; path?: string; local?: boolean }
    return { ok: true, sha: data.sha, path: data.path, local: data.local }
  } catch {
    return { ok: false, error: '网络错误' }
  }
}

export async function deleteFiles(paths: string[]): Promise<boolean> {
  try {
    const response = await fetch('/api/file', {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
    return response.ok
  } catch {
    return false
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
  releaseNotes: string
  releaseUrl: string
  publishedAt: string
}

export async function checkUpdate(
  currentVersion: string,
  githubProxy?: string,
): Promise<{ ok: boolean; data?: UpdateInfo; error?: string }> {
  try {
    const params = new URLSearchParams({ current: currentVersion })
    if (githubProxy?.trim()) params.set('githubProxy', githubProxy.trim())
    const response = await fetch(`/api/check-update?${params.toString()}`, {
      credentials: 'include',
    })
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      return { ok: false, error: data.error || '检查失败' }
    }
    const data = (await response.json()) as UpdateInfo
    return { ok: true, data }
  } catch {
    return { ok: false, error: '网络错误' }
  }
}

export async function triggerUpdate(githubProxy?: string): Promise<SaveResult> {
  try {
    const response = await fetch('/api/update', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ githubProxy: githubProxy?.trim() || '' }),
    })
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      return { ok: false, error: data.error || '触发失败' }
    }
    const data = (await response.json().catch(() => ({}))) as { message?: string }
    return { ok: true, message: data.message }
  } catch {
    return { ok: false, error: '网络错误' }
  }
}
