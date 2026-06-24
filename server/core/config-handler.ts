import { isLocalMode, isPublicHttpUrl, type Env, type ValidationResult } from './types'
import { GitHubWriteError, readFile, writeFile, utf8ToBase64, type GitHubFile } from './github'
import { encryptString, decryptString, looksEncrypted } from './crypto'

const CONFIG_PATH = 'public/config.json'

const DEFAULT_CONFIG = JSON.stringify({
  siteName: 'Meliora',
  apiEndpoint: '',
  playlists: [],
  localTracks: [],
})

let localConfigCache: string | null = null

const CONFIG_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
}

export function validateConfig(input: unknown): ValidationResult {
  const errors: string[] = []

  if (typeof input !== 'object' || input === null) {
    return { valid: false, errors: ['配置必须是一个对象'] }
  }

  const config = input as Record<string, unknown>

  if (typeof config.siteName !== 'string' || !config.siteName.trim()) {
    errors.push('siteName 必须是非空字符串')
  }

  if (config.siteIcon !== undefined && typeof config.siteIcon !== 'string') {
    errors.push('siteIcon 必须是字符串')
  }

  if (typeof config.apiEndpoint !== 'string' || !config.apiEndpoint.trim()) {
    errors.push('apiEndpoint 必须是非空字符串')
  } else if (!isPublicHttpUrl(config.apiEndpoint)) {
    errors.push('apiEndpoint 必须是公网 http(s) URL,不允许内网或本地地址')
  }

  if (config.apiToken !== undefined && typeof config.apiToken !== 'string') {
    errors.push('apiToken 必须是字符串')
  }

  if (config.githubProxy !== undefined && typeof config.githubProxy !== 'string') {
    errors.push('githubProxy 必须是字符串')
  }

  if (config.umami !== undefined) {
    if (typeof config.umami !== 'object' || config.umami === null) {
      errors.push('umami 必须是对象')
    } else {
      const umami = config.umami as Record<string, unknown>
      if (umami.enabled !== undefined && typeof umami.enabled !== 'boolean') {
        errors.push('umami.enabled 必须是布尔值')
      }
      if (umami.scriptUrl !== undefined && typeof umami.scriptUrl !== 'string') {
        errors.push('umami.scriptUrl 必须是字符串')
      }
      if (umami.websiteId !== undefined && typeof umami.websiteId !== 'string') {
        errors.push('umami.websiteId 必须是字符串')
      }
    }
  }

  if (config.googleAnalytics !== undefined) {
    if (typeof config.googleAnalytics !== 'object' || config.googleAnalytics === null) {
      errors.push('googleAnalytics 必须是对象')
    } else {
      const googleAnalytics = config.googleAnalytics as Record<string, unknown>
      if (googleAnalytics.enabled !== undefined && typeof googleAnalytics.enabled !== 'boolean') {
        errors.push('googleAnalytics.enabled 必须是布尔值')
      }
      if (
        googleAnalytics.measurementId !== undefined &&
        typeof googleAnalytics.measurementId !== 'string'
      ) {
        errors.push('googleAnalytics.measurementId 必须是字符串')
      }
    }
  }

  if (
    config.googleSiteVerification !== undefined &&
    typeof config.googleSiteVerification !== 'string'
  ) {
    errors.push('googleSiteVerification 必须是字符串')
  }

  if (config.customCss !== undefined && typeof config.customCss !== 'string') {
    errors.push('customCss 必须是字符串')
  }

  if (config.customJs !== undefined && typeof config.customJs !== 'string') {
    errors.push('customJs 必须是字符串')
  }

  if (!Array.isArray(config.playlists)) {
    errors.push('playlists 必须是数组')
  } else {
    config.playlists.forEach((item, index) => {
      if (typeof item !== 'object' || item === null) {
        errors.push(`playlists[${index}] 必须是对象`)
        return
      }
      const playlist = item as Record<string, unknown>
      if (playlist.server !== 'netease' && playlist.server !== 'tencent') {
        errors.push(`playlists[${index}].server 必须是 netease 或 tencent`)
      }
      if (typeof playlist.playlistId !== 'string' || !playlist.playlistId.trim()) {
        errors.push(`playlists[${index}].playlistId 必须是非空字符串`)
      }
    })
  }

  if (!Array.isArray(config.localTracks)) {
    errors.push('localTracks 必须是数组')
  } else {
    config.localTracks.forEach((item, index) => {
      if (typeof item !== 'object' || item === null) {
        errors.push(`localTracks[${index}] 必须是对象`)
        return
      }
      const track = item as Record<string, unknown>
      if (typeof track.id !== 'string' || !track.id.trim()) {
        errors.push(`localTracks[${index}].id 必须是非空字符串`)
      }
      if (typeof track.title !== 'string' || !track.title.trim()) {
        errors.push(`localTracks[${index}].title 必须是非空字符串`)
      }
      if (typeof track.artist !== 'string' || !track.artist.trim()) {
        errors.push(`localTracks[${index}].artist 必须是非空字符串`)
      }
      if (typeof track.audio !== 'string' || !track.audio.trim()) {
        errors.push(`localTracks[${index}].audio 必须是非空字符串`)
      }
    })
  }

  return { valid: errors.length === 0, errors }
}

export async function getConfig(env: Env): Promise<Response> {
  if (isLocalMode(env)) {
    const content = localConfigCache || DEFAULT_CONFIG
    return new Response(content, {
      status: 200,
      headers: CONFIG_HEADERS,
    })
  }

  let file: GitHubFile | null
  try {
    file = await readFile(CONFIG_PATH, env)
  } catch (error) {
    // GitHub API 故障时降级到默认配置,保证播放器加载可用,
    // 但记录错误以便运维感知(区别于"文件不存在"的正常空配置)。
    console.error('getConfig readFile failed, falling back to default:', error)
    return new Response(DEFAULT_CONFIG, {
      status: 200,
      headers: CONFIG_HEADERS,
    })
  }
  if (!file) {
    return new Response(DEFAULT_CONFIG, {
      status: 200,
      headers: CONFIG_HEADERS,
    })
  }
  try {
    // 生产模式下仅接受密文;明文 JSON 视为损坏或未初始化,回落到默认配置。
    if (looksEncrypted(file.content)) {
      const plaintext = await decryptString(file.content, env)
      return new Response(plaintext, {
        status: 200,
        headers: CONFIG_HEADERS,
      })
    }
    console.error('config.json is not encrypted, falling back to default')
    return new Response(DEFAULT_CONFIG, {
      status: 200,
      headers: CONFIG_HEADERS,
    })
  } catch (error) {
    console.error('config.json decryption failed, falling back to default:', error)
    return new Response(DEFAULT_CONFIG, {
      status: 200,
      headers: CONFIG_HEADERS,
    })
  }
}

export async function putConfig(body: unknown, env: Env): Promise<Response> {
  const validation = validateConfig(body)
  if (!validation.valid) {
    return new Response(JSON.stringify({ error: '配置校验失败', details: validation.errors }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const content = JSON.stringify(body, null, 2)

  if (isLocalMode(env)) {
    localConfigCache = content
    return new Response(JSON.stringify({ sha: 'local-dev', local: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const encrypted = await encryptString(content, env)
  let existing: GitHubFile | null
  try {
    existing = await readFile(CONFIG_PATH, env)
  } catch {
    return new Response(JSON.stringify({ error: '读取当前配置失败,请稍后重试' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const message = `chore(config): update config via admin ${new Date().toISOString()}`

  try {
    const sha = await writeFile(CONFIG_PATH, utf8ToBase64(encrypted), env, message, existing?.sha)
    return new Response(JSON.stringify({ sha }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    // sha 乐观锁冲突:配置已被其他操作修改,提示用户刷新重试,而非直接 500。
    if (error instanceof GitHubWriteError && (error.status === 409 || error.status === 422)) {
      return new Response(JSON.stringify({ error: '配置已被其他操作修改,请刷新后重试' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw error
  }
}
