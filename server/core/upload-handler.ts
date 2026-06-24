import { isLocalMode, type Env, type UploadPayload } from './types'
import { readFile, writeFile, deleteFile } from './github'

const ALLOWED_UPLOAD_PREFIXES = ['public/']
// 受保护的关键文件:仅能通过专用接口(/api/config、/api/setup、/api/change-password)修改,
// 禁止通过 /api/upload 覆盖。否则攻击者认证后可覆盖 admin.json 让 /setup 重新开放接管后台,
// 或覆盖 config.json 静默重置站点配置。
const PROTECTED_UPLOAD_PATHS = new Set(['public/admin.json', 'public/config.json'])

function isAllowedUploadPath(path: string): boolean {
  if (!path || path.includes('\0')) return false
  // 用 URL 解析规范化路径,消除 ../、./、多余的 / 等穿越手法
  let normalized: string
  try {
    normalized = new URL(path, 'http://localhost/').pathname.slice(1)
  } catch {
    return false
  }
  if (
    !normalized ||
    normalized.startsWith('..') ||
    normalized.includes('/../') ||
    normalized.includes('/./')
  ) {
    return false
  }
  if (PROTECTED_UPLOAD_PATHS.has(normalized)) return false
  return ALLOWED_UPLOAD_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

export async function uploadFile(body: UploadPayload, env: Env): Promise<Response> {
  const { path, content } = body

  if (!path || !content) {
    return new Response(JSON.stringify({ error: '缺少 path 或 content' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!isAllowedUploadPath(path)) {
    return new Response(JSON.stringify({ error: '路径不在允许范围内' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (isLocalMode(env)) {
    return new Response(JSON.stringify({ sha: 'local-dev', path, local: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const existing = await readFile(path, env)
    const message = `chore(music): upload ${path} via admin ${new Date().toISOString()}`
    // content 由前端 FileReader.readAsDataURL 读取后以 base64 提供,
    // 已是 GitHub Contents API 所需的 base64 编码,直接透传给 writeFile,不再二次编码。
    const sha = await writeFile(path, content, env, message, existing?.sha)
    return new Response(JSON.stringify({ sha, path }), {
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
  if (isLocalMode(env)) {
    const summary = paths.map((path) => ({
      path,
      deleted: isAllowedUploadPath(path),
    }))
    return new Response(JSON.stringify({ results: summary }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const results = await Promise.allSettled(
    paths.map(async (path) => {
      if (!isAllowedUploadPath(path)) return { path, deleted: false }
      const file = await readFile(path, env)
      if (!file) return { path, deleted: false }
      const message = `chore(music): delete ${path} via admin ${new Date().toISOString()}`
      await deleteFile(path, env, message, file.sha)
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
