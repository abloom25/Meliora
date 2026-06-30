import { isDevelopmentMode, type Env, type UploadPayload } from './types'
import { readFile, writeFile, deleteFile } from './github'

const MUSIC_UPLOAD_PREFIX = 'public/music/'
const SITE_ICON_UPLOAD_PATTERN = /^public\/icon\.(?:png|jpe?g|webp|ico)$/i
const ALLOWED_MUSIC_EXTENSIONS = new Set([
  '.aac',
  '.avif',
  '.flac',
  '.gif',
  '.jpeg',
  '.jpg',
  '.lrc',
  '.m4a',
  '.mp3',
  '.ogg',
  '.opus',
  '.png',
  '.srt',
  '.txt',
  '.vtt',
  '.wav',
  '.webm',
  '.webp',
])
const BLOCKED_PUBLIC_PATHS = new Set([
  'public/admin.json',
  'public/config.json',
  'public/manifest.json',
  'public/manifest.webmanifest',
  'public/robots.txt',
  'public/sw.js',
  'public/_routes.json',
])
const BLOCKED_UPLOAD_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.htm',
  '.html',
  '.js',
  '.mjs',
  '.svg',
  '.wasm',
  '.xhtml',
])
// 受保护的关键文件:仅能通过专用接口(/api/config、/api/setup、/api/change-password)修改,
// 禁止通过 /api/upload 覆盖。否则攻击者认证后可覆盖 admin.json 让 /setup 重新开放接管后台,
// 或覆盖 config.json 静默重置站点配置。PWA/SEO/路由与可执行前端资源同样禁止覆盖。

function extensionOf(path: string): string {
  const filename = path.split('/').pop() || ''
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot).toLowerCase() : ''
}

function hasUrlScheme(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(path.trim())
}

function isAllowedUploadPath(path: string): { allowed: boolean; normalizedPath: string } {
  if (!path || path.includes('\0')) return { allowed: false, normalizedPath: '' }
  if (hasUrlScheme(path)) return { allowed: false, normalizedPath: '' }

  const rawSegments = path.replace(/\\/g, '/').split('/')
  if (rawSegments.some((segment) => segment === '..')) {
    return { allowed: false, normalizedPath: '' }
  }

  let normalized: string
  try {
    normalized = new URL(path.replace(/\\/g, '/'), 'http://localhost/').pathname.slice(1)
  } catch {
    return { allowed: false, normalizedPath: '' }
  }

  try {
    normalized = decodeURIComponent(normalized)
  } catch {
    return { allowed: false, normalizedPath: '' }
  }
  if (
    !normalized ||
    normalized.startsWith('..') ||
    normalized.includes('/../') ||
    normalized.includes('/./') ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    return { allowed: false, normalizedPath: '' }
  }
  const extension = extensionOf(normalized)
  if (BLOCKED_PUBLIC_PATHS.has(normalized) || BLOCKED_UPLOAD_EXTENSIONS.has(extension)) {
    return { allowed: false, normalizedPath: '' }
  }

  if (normalized.startsWith(MUSIC_UPLOAD_PREFIX)) {
    if (!ALLOWED_MUSIC_EXTENSIONS.has(extension)) {
      return { allowed: false, normalizedPath: '' }
    }
    return { allowed: true, normalizedPath: normalized }
  }

  if (SITE_ICON_UPLOAD_PATTERN.test(normalized)) {
    return { allowed: true, normalizedPath: normalized }
  }

  return { allowed: false, normalizedPath: '' }
}

export async function uploadFile(body: UploadPayload, env: Env): Promise<Response> {
  const { path, content } = body

  if (!path || !content) {
    return new Response(JSON.stringify({ error: '缺少 path 或 content' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const pathCheck = isAllowedUploadPath(path)
  if (!pathCheck.allowed) {
    return new Response(JSON.stringify({ error: '路径不在允许范围内' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (isDevelopmentMode(env)) {
    return new Response(
      JSON.stringify({ sha: 'local-dev', path: pathCheck.normalizedPath, local: true }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }

  try {
    const existing = await readFile(pathCheck.normalizedPath, env)
    const message = `chore(music): upload ${pathCheck.normalizedPath} via admin ${new Date().toISOString()}`
    // content 由前端 FileReader.readAsDataURL 读取后以 base64 提供,
    // 已是 GitHub Contents API 所需的 base64 编码,直接透传给 writeFile,不再二次编码。
    const sha = await writeFile(pathCheck.normalizedPath, content, env, message, existing?.sha)
    return new Response(JSON.stringify({ sha, path: pathCheck.normalizedPath }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch {
    return new Response(JSON.stringify({ error: '文件上传失败' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

export async function deleteTrackFiles(paths: string[], env: Env): Promise<Response> {
  if (isDevelopmentMode(env)) {
    const summary = paths.map((path) => {
      const pathCheck = isAllowedUploadPath(path)
      return {
        path,
        deleted: pathCheck.allowed,
      }
    })
    return new Response(JSON.stringify({ results: summary }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const results = await Promise.allSettled(
    paths.map(async (path) => {
      const pathCheck = isAllowedUploadPath(path)
      if (!pathCheck.allowed) return { path, deleted: false }
      const file = await readFile(pathCheck.normalizedPath, env)
      if (!file) return { path, deleted: true }
      const message = `chore(music): delete ${pathCheck.normalizedPath} via admin ${new Date().toISOString()}`
      await deleteFile(pathCheck.normalizedPath, env, message, file.sha)
      return { path, deleted: true }
    }),
  )

  const summary = results.map((result, index) => ({
    path: paths[index],
    deleted: result.status === 'fulfilled' && result.value.deleted,
  }))

  return new Response(JSON.stringify({ results: summary }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
