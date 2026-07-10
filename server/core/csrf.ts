import { CSRF_CONSTANTS } from '../../shared/constants'

const CSRF_MAX_AGE_MS = CSRF_CONSTANTS.MAX_AGE

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16)
  }
  return bytes
}

/**
 * 生成带签名的 CSRF token
 * 使用 HMAC-SHA256 签名确保 token 无法被伪造
 * @param secret 签名密钥
 * @returns 格式为 "signature.timestamp" 的 token
 */
export async function generateCsrfToken(secret: string): Promise<string> {
  const timestamp = Date.now()
  const timestampHex = timestamp.toString(16).padStart(16, '0')

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(timestampHex))

  const signatureHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  return `${signatureHex}.${timestampHex}`
}

/**
 * 验证 CSRF token 是否有效
 * 使用 HMAC 签名验证确保 token 无法被伪造
 * @param token 需要验证的 token
 * @param secret 签名密钥
 * @returns token 是否有效
 */
export async function verifyCsrfToken(token: string, secret: string): Promise<boolean> {
  if (!token || !secret) return false

  try {
    const parts = token.split('.')
    if (parts.length !== 2) return false

    const [receivedSignature, receivedTimestamp] = parts

    // 验证时间戳格式（16位十六进制）
    if (!/^[0-9a-f]{16}$/i.test(receivedTimestamp)) {
      return false
    }

    // 验证签名格式（64位十六进制，对应 32 字节）
    if (!/^[0-9a-f]{64}$/i.test(receivedSignature)) {
      return false
    }

    // 验证时间戳（7天有效期）
    const timestamp = parseInt(receivedTimestamp, 16)
    const now = Date.now()
    if (now - timestamp > CSRF_MAX_AGE_MS || timestamp > now) {
      return false
    }

    // 验证签名
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )

    return crypto.subtle.verify(
      'HMAC',
      key,
      hexToBytes(receivedSignature) as BufferSource,
      encoder.encode(receivedTimestamp),
    )
  } catch {
    return false
  }
}

/**
 * 从请求中提取 CSRF token
 * @param request HTTP 请求对象
 * @returns CSRF token 或 null
 */
export function extractCsrfToken(request: Request): string | null {
  // 必须由前端显式复制到自定义请求头。不能接受 Cookie 自身作为证明，
  // 否则浏览器在跨站请求中自动携带 Cookie 时会失去 CSRF 防护意义。
  return request.headers.get('X-CSRF-Token')
}

/**
 * 创建包含 CSRF token 的响应头
 * @param token CSRF token
 * @param extraHeaders 额外的响应头
 * @returns 响应头对象
 */
export function createCsrfHeaders(
  token: string,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  return {
    'X-CSRF-Token': token,
    ...extraHeaders,
  }
}

/**
 * 验证请求是否包含有效的 CSRF token
 * @param request HTTP 请求对象
 * @param secret 签名密钥
 * @returns 验证结果
 */
export async function validateCsrfRequest(request: Request, secret: string): Promise<boolean> {
  // GET 请求不需要 CSRF 保护
  if (request.method === 'GET') return true

  // OPTIONS 请求不需要 CSRF 保护
  if (request.method === 'OPTIONS') return true

  // 提取并验证 token
  const token = await extractCsrfToken(request)
  if (!token) return false

  return verifyCsrfToken(token, secret)
}

/**
 * 检查请求是否需要 CSRF 保护
 * @param request HTTP 请求对象
 * @returns 是否需要 CSRF 保护
 */
export function requiresCsrfProtection(request: Request): boolean {
  // GET 和 OPTIONS 请求不需要 CSRF 保护
  if (request.method === 'GET' || request.method === 'OPTIONS') {
    return false
  }

  // 检查是否为 API 请求
  const url = new URL(request.url)
  return url.pathname.startsWith('/api/')
}
