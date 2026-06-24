import type { ConfigPayload, Env } from './types'
import { signToken, createCookieHeader, createClearCookieHeader, verifyAuth } from './auth'
import { getConfig, putConfig } from './config-handler'
import { uploadFile, deleteTrackFiles } from './upload-handler'
import {
  verifyAdminPassword,
  isInitialized,
  setupPassword,
  changePassword,
} from './admin-auth-store'
import { validateEnv } from './types'
import { checkUpdate, triggerUpdate } from './update-handler'
import { testMusicApi } from './music-api-tester'
import { consumeRateLimit, resetRateLimit } from './rate-limit'
import { renderEnvNotReadyPage, renderDisabledPage } from './status-pages'

const LOGIN_RATE_LIMIT = {
  key: 'login',
  limit: 8,
  windowMs: 10 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
}

const SETUP_RATE_LIMIT = {
  key: 'setup',
  limit: 5,
  windowMs: 10 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
}

const UPDATE_RATE_LIMIT = {
  key: 'update',
  limit: 3,
  windowMs: 10 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
}

// changePassword 执行 PBKDF2 100k 迭代(CPU 密集),token 泄露后可被滥用消耗 CPU,故限流。
const CHANGE_PASSWORD_RATE_LIMIT = {
  key: 'change-password',
  limit: 5,
  windowMs: 10 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
}

// testMusicApi 发起外部 fetch,可被用于 SSRF 探测/DoS,故限流。
const TEST_MUSIC_API_RATE_LIMIT = {
  key: 'test-music-api',
  limit: 10,
  windowMs: 10 * 60 * 1000,
  blockMs: 5 * 60 * 1000,
}

function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

function rateLimitResponse(retryAfterSeconds: number): Response {
  return jsonResponse({ error: '请求过于频繁,请稍后再试' }, 429, {
    'Retry-After': String(retryAfterSeconds),
  })
}

// 归一化判断 ADMIN_DISABLED 是否为真值。
// 接受 true/1/yes/on(大小写、首尾空格不敏感),避免部署平台惯用值不生效且无提示。
function isDisabledValue(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'on'
}

// 状态探针端点:禁用或环境未就绪时仍需返回对应状态页,供 /admin 前端感知并整页替换。
function isStatusProbe(path: string, method: string): boolean {
  return method === 'GET' && (path === '/api/setup-status' || path === '/api/status-page')
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    // 管理后台 API 为同域调用(SameSite=Lax Cookie 鉴权),不需要跨域 CORS 支持。
    // 之前版本反射任意 Origin 并允许 Credentials 是危险的半成品:一旦补上响应 CORS 头,
    // 任意站点即可携带 Cookie 调用管理 API。此处返回 204 不带 CORS 头,浏览器会阻止跨域请求。
    return new Response(null, { status: 204 })
  }

  const url = new URL(request.url)
  const path = url.pathname

  const envCheck = validateEnv(env)
  const isDisabled = isDisabledValue(env.ADMIN_DISABLED)

  if (!envCheck.ok || isDisabled) {
    if (isStatusProbe(path, request.method)) {
      return isDisabled ? renderDisabledPage() : renderEnvNotReadyPage(envCheck)
    }
    // 播放器加载配置不依赖管理后台,禁用或环境未就绪时仍放行,保证前端播放能力可用。
    if (path === '/api/runtime-config' && request.method === 'GET') {
      return getConfig(env)
    }
    return jsonResponse({ error: isDisabled ? '管理后台已禁用' : '环境变量未就绪' }, 403)
  }

  try {
    if (path === '/api/login' && request.method === 'POST') {
      const rateLimit = consumeRateLimit(request, LOGIN_RATE_LIMIT)
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterSeconds)
      }

      const body = (await request.json().catch(() => ({}))) as { password?: string }
      if (!body.password) {
        return jsonResponse({ error: '密码错误' }, 401)
      }
      const valid = await verifyAdminPassword(body.password, env)
      if (!valid) {
        return jsonResponse({ error: '密码错误' }, 401)
      }
      const token = await signToken(env)
      resetRateLimit(request, LOGIN_RATE_LIMIT.key)
      return jsonResponse({ success: true }, 200, { 'Set-Cookie': createCookieHeader(token) })
    }

    if (path === '/api/logout' && request.method === 'POST') {
      return jsonResponse({ success: true }, 200, { 'Set-Cookie': createClearCookieHeader() })
    }

    if (path === '/api/auth' && request.method === 'GET') {
      const authenticated = await verifyAuth(request, env)
      return jsonResponse({ authenticated }, 200)
    }

    if (path === '/api/setup-status' && request.method === 'GET') {
      const initialized = await isInitialized(env)
      return jsonResponse({ initialized }, 200)
    }

    if (path === '/api/setup' && request.method === 'POST') {
      const rateLimit = consumeRateLimit(request, SETUP_RATE_LIMIT)
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterSeconds)
      }

      const initialized = await isInitialized(env)
      if (initialized) {
        return jsonResponse({ error: '密码已初始化' }, 409)
      }
      const body = (await request.json().catch(() => ({}))) as { password?: string }
      if (!body.password) {
        return jsonResponse({ error: '请输入密码' }, 400)
      }
      const result = await setupPassword(body.password, env)
      if (!result.ok) {
        return jsonResponse({ error: result.error || '初始化失败' }, 400)
      }
      const token = await signToken(env)
      resetRateLimit(request, SETUP_RATE_LIMIT.key)
      return jsonResponse({ success: true }, 200, { 'Set-Cookie': createCookieHeader(token) })
    }

    if (path === '/api/runtime-config' && request.method === 'GET') {
      return getConfig(env)
    }

    if (path === '/api/check-update' && request.method === 'GET') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      return checkUpdate(
        url.searchParams.get('current') || '',
        env,
        url.searchParams.get('githubProxy') || undefined,
      )
    }

    if (path === '/api/update' && request.method === 'POST') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      const rateLimit = consumeRateLimit(request, UPDATE_RATE_LIMIT)
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterSeconds)
      }
      const body = (await request.json().catch(() => ({}))) as { githubProxy?: string }
      return triggerUpdate(env, body.githubProxy)
    }

    if (path === '/api/change-password' && request.method === 'POST') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      const rateLimit = consumeRateLimit(request, CHANGE_PASSWORD_RATE_LIMIT)
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterSeconds)
      }
      const body = (await request.json().catch(() => ({}))) as {
        current?: string
        next?: string
      }
      if (!body.current || !body.next) {
        return jsonResponse({ error: '缺少当前密码或新密码' }, 400)
      }
      const result = await changePassword(body.current, body.next, env)
      if (!result.ok) {
        return jsonResponse({ error: result.error || '修改失败' }, 400)
      }
      return jsonResponse({ success: true }, 200)
    }

    if (path === '/api/test-music-api' && request.method === 'POST') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      const rateLimit = consumeRateLimit(request, TEST_MUSIC_API_RATE_LIMIT)
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterSeconds)
      }
      const body = await request.json().catch(() => null)
      if (!body || typeof body !== 'object') {
        return jsonResponse({ error: '配置无效' }, 400)
      }
      return testMusicApi(body as ConfigPayload)
    }

    if (path === '/api/config' && request.method === 'GET') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      return getConfig(env)
    }

    if (path === '/api/config' && request.method === 'PUT') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      const body = await request.json().catch(() => null)
      return putConfig(body, env)
    }

    if (path === '/api/upload' && request.method === 'POST') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      const body = (await request.json().catch(() => null)) as {
        path?: string
        content?: string
      } | null
      if (!body || !body.path || !body.content) {
        return jsonResponse({ error: '缺少 path 或 content' }, 400)
      }
      // 限制单次上传体积,防止超大 base64 撑爆 Edge 实例内存。
      // content 为 base64 字符串,长度 × 3/4 ≈ 解码后字节数,按字符串长度粗略限制 25MB。
      const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
      if (body.content.length > (MAX_UPLOAD_BYTES * 4) / 3) {
        return jsonResponse({ error: '文件过大,最大 25MB' }, 413)
      }
      return uploadFile({ path: body.path, content: body.content }, env)
    }

    if (path === '/api/file' && request.method === 'DELETE') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      const body = (await request.json().catch(() => null)) as { paths?: string[] } | null
      if (!body || !Array.isArray(body.paths)) {
        return jsonResponse({ error: '缺少 paths' }, 400)
      }
      // 限制单次删除数量,避免并发发起大量 GitHub API 请求触发速率限制或超时。
      if (body.paths.length > 50) {
        return jsonResponse({ error: '单次最多删除 50 个文件' }, 400)
      }
      return deleteTrackFiles(body.paths, env)
    }

    return jsonResponse({ error: '未找到' }, 404)
  } catch (error) {
    // 记录未捕获异常,便于运维排查。Edge 环境调试困难,不能静默吞错。
    console.error('handleRequest unhandled error:', error)
    return jsonResponse({ error: '服务器内部错误' }, 500)
  }
}
