import { isLocalMode, type Env } from './types'
import { getTokenVersion } from './admin-auth-store'

const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const COOKIE_NAME = 'meliora_admin'

export async function getSigningSecret(env: Env): Promise<string> {
  if (isLocalMode(env)) {
    return 'meliora-local-dev-signing-secret'
  }
  // 签名密钥原料固定使用 CONFIG_ENCRYPTION_KEY,与配置加密密钥一致且与 GH_TOKEN 解耦,
  // GH_TOKEN 轮换不影响已签发的 Cookie token。
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.CONFIG_ENCRYPTION_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode('meliora-cookie-signing'))
  const bytes = new Uint8Array(sig)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlToBytes(str: string): Uint8Array {
  const padded = str
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(str.length + ((4 - (str.length % 4)) % 4), '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

// token payload 携带 ver( tokenVersion),changePassword 后 ver 不匹配的旧 token 被拒绝,
// 实现改密码即吊销所有已签发 token。
export async function signToken(env: Env, maxAgeMs: number = TOKEN_MAX_AGE_MS): Promise<string> {
  const secret = await getSigningSecret(env)
  const ver = await getTokenVersion(env)
  const payload = { exp: Date.now() + maxAgeMs, ver }
  const payloadJson = JSON.stringify(payload)
  const payloadB64 = bytesToBase64url(new TextEncoder().encode(payloadJson))

  const key = await hmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64))
  const sigB64 = bytesToBase64url(new Uint8Array(sig))

  return `${payloadB64}.${sigB64}`
}

export async function verifyToken(
  token: string,
  secret: string,
  expectedVer?: number,
): Promise<boolean> {
  try {
    const parts = token.split('.')
    if (parts.length !== 2) return false
    const [payloadB64, sigB64] = parts

    const key = await hmacKey(secret)
    const sigBytes = base64urlToBytes(sigB64)
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes.buffer as ArrayBuffer,
      new TextEncoder().encode(payloadB64).buffer as ArrayBuffer,
    )
    if (!valid) return false

    const payloadJson = new TextDecoder().decode(base64urlToBytes(payloadB64))
    const payload = JSON.parse(payloadJson) as { exp: number; ver?: number }
    if (payload.exp <= Date.now()) return false
    // ver 校验:expectedVer 由 verifyAuth 从 admin.json 的 tokenVersion 传入。
    // 旧 token(无 ver 或 ver 不匹配)在 changePassword 后被拒绝。
    if (expectedVer !== undefined && payload.ver !== expectedVer) return false
    return true
  } catch {
    return false
  }
}

export function createCookieHeader(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`
}

export function createClearCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
}

export function parseCookies(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  return match ? match[1] : null
}

export async function verifyAuth(request: Request, env: Env): Promise<boolean> {
  const cookie = parseCookies(request.headers.get('Cookie'))
  if (!cookie) return false
  const secret = await getSigningSecret(env)
  const expectedVer = await getTokenVersion(env)
  return verifyToken(cookie, secret, expectedVer)
}

export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const aBytes = encoder.encode(a)
  const bBytes = encoder.encode(b)
  if (aBytes.length !== bBytes.length) return false
  let result = 0
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i]
  }
  return result === 0
}
