import { isDevelopmentMode, validateEncryptionKey, type Env } from './types'
import { GitHubWriteError, readFile, writeFile, utf8ToBase64 } from './github'
import { encryptString, decryptString, looksEncrypted } from './crypto'
import { logSanitizedError } from './error-handler'
import { AUTH_CONSTANTS } from '../../shared/constants'

const ADMIN_PATH = 'public/admin.json'
// PBKDF2 迭代次数:遵循 OWASP 当前建议(PBKDF2-HMAC-SHA-256 ≥ 600k)。
// 迭代次数写入哈希串(pbkdf2$<iter>$<salt>$<hash>),verifyPassword 按存储值验证,
// 因此提升该常量向后兼容 —— 旧哈希仍按其存储次数验证,新设置/改密时使用更高的新次数。
// 注意:此处的迭代次数仅用于管理员密码哈希,与 crypto.ts 中派生配置加密密钥的
// PBKDF2 迭代次数相互独立(后者变更会令已加密配置不可解,不可随意调整)。
const PBKDF2_ITERATIONS = AUTH_CONSTANTS.PBKDF2_ITERATIONS
const MIN_PASSWORD_LENGTH = AUTH_CONSTANTS.MIN_PASSWORD_LENGTH

// 管理员数据结构
export interface AdminData {
  passwordHash?: string
  tokenVersion?: number
  role?: 'admin' | 'viewer'
  createdAt?: number
}

const DEFAULT_ADMIN_DATA: AdminData = {
  role: 'admin',
  createdAt: Date.now(),
}

let localAdminCache: { passwordHash?: string; tokenVersion?: number } | null = null
let localSetupPending = false

// tokenVersion 内存缓存:changePassword 时 bump 并写入 admin.json,
// 使旧 Cookie token 的 ver 失效。Edge Function 实例复用期间命中缓存,
// 新实例冷启动时从 admin.json 加载,最终一致。
// 缓存带短 TTL:其他实例在 changePassword 后最多 TTL 内会重新从 admin.json
// 加载最新 ver,避免旧 token 在跨实例场景下长期有效,削弱"改密码即吊销"语义。
// TTL 取 5s(而非更长的 30s):管理后台为低频流量,单次 dashboard 加载后即命中缓存,
// 短 TTL 对 GitHub API 调用影响可忽略,却将跨实例撤销窗口缩到最小。
// 跨实例无共享存储是 Edge 固有限制,彻底消除需 Durable Objects / KV。
const TOKEN_VERSION_TTL_MS = AUTH_CONSTANTS.TOKEN_VERSION_TTL
let cachedTokenVersion: number | null = null
let tokenVersionExpiresAt = 0

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToBytes(str: string): Uint8Array {
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function pbkdf2Hash(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256,
  )
  return new Uint8Array(bits)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await pbkdf2Hash(password, salt)
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$')
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
    const iterations = parseInt(parts[1], 10)
    const salt = base64ToBytes(parts[2])
    const expectedHash = parts[3]

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    )
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
      keyMaterial,
      256,
    )
    const actualHash = bytesToBase64(new Uint8Array(bits))
    return timingSafeEqualString(actualHash, expectedHash)
  } catch {
    return false
  }
}

// 与 auth.ts 的 timingSafeEqual 一致:先固定长度比较避免长度泄露,
// 再逐字节异或。base64 输出长度固定,但保持一致实现以防回归。
function timingSafeEqualString(a: string, b: string): boolean {
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

async function readAdminData(env: Env): Promise<AdminData> {
  if (isDevelopmentMode(env)) {
    return localAdminCache || {}
  }
  const file = await readFile(ADMIN_PATH, env)
  if (!file) return {}
  // 生产模式下仅接受密文。明文 JSON 或解密失败均视为损坏,
  // 抛错而非返回空对象,避免 isInitialized 误判为 false 进而重新开放 /setup
  // (CONFIG_ENCRYPTION_KEY 被更换后旧密文不可解,绝不能因此开放重新设置密码)。
  if (!looksEncrypted(file.content)) {
    throw new Error('admin.json is not encrypted')
  }
  const content = await decryptString(file.content, env)
  return JSON.parse(content) as AdminData
}

async function writeAdminData(data: AdminData, env: Env): Promise<void> {
  if (isDevelopmentMode(env)) {
    localAdminCache = data
    return
  }
  const content = JSON.stringify(data, null, 2)
  const encrypted = await encryptString(content, env)
  const existing = await readFile(ADMIN_PATH, env)
  const message = `chore(admin): update admin data via admin ${new Date().toISOString()}`
  await writeFile(ADMIN_PATH, utf8ToBase64(encrypted), env, message, existing?.sha)
}

async function createAdminData(
  data: AdminData,
  env: Env,
): Promise<{ ok: boolean; exists: boolean }> {
  if (isDevelopmentMode(env)) {
    if (localAdminCache?.passwordHash || localSetupPending) {
      return { ok: false, exists: true }
    }
    localSetupPending = true
    try {
      localAdminCache = data
      return { ok: true, exists: false }
    } finally {
      localSetupPending = false
    }
  }

  const content = JSON.stringify(data, null, 2)
  const encrypted = await encryptString(content, env)
  const message = `chore(admin): initialize admin data ${new Date().toISOString()}`

  try {
    await writeFile(ADMIN_PATH, utf8ToBase64(encrypted), env, message)
    return { ok: true, exists: false }
  } catch (error) {
    if (error instanceof GitHubWriteError && (error.status === 409 || error.status === 422)) {
      return { ok: false, exists: true }
    }
    throw error
  }
}

export async function verifyAdminPassword(password: string, env: Env): Promise<boolean> {
  const adminData = await readAdminData(env)
  if (adminData.passwordHash) {
    return verifyPassword(password, adminData.passwordHash)
  }
  return false
}

export async function isInitialized(env: Env): Promise<boolean> {
  const adminData = await readAdminData(env)
  return Boolean(adminData.passwordHash)
}

// 获取当前 token 版本。缓存命中时无网络 IO;
// 冷启动时从 admin.json 加载并缓存。
export async function getTokenVersion(env: Env): Promise<number> {
  if (cachedTokenVersion !== null && Date.now() < tokenVersionExpiresAt) {
    return cachedTokenVersion
  }
  const adminData = await readAdminData(env)
  cachedTokenVersion = adminData.tokenVersion ?? 0
  tokenVersionExpiresAt = Date.now() + TOKEN_VERSION_TTL_MS
  return cachedTokenVersion
}

export async function setupPassword(
  password: string,
  env: Env,
): Promise<{ ok: boolean; error?: string }> {
  // 最先校验加密密钥:生产模式下 CONFIG_ENCRYPTION_KEY 必填且需达到最低强度,
  // 否则拒绝初始化,避免用弱密钥加密后无法补救。开发模式跳过(不加密)。
  const keyCheck = validateEncryptionKey(env)
  if (!keyCheck.ok) {
    return { ok: false, error: keyCheck.error }
  }
  // 再做本地密码校验(无网络 IO),最后读取已初始化状态。
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `密码至少 ${MIN_PASSWORD_LENGTH} 位` }
  }
  try {
    const adminData = await readAdminData(env)
    if (adminData.passwordHash) {
      return { ok: false, error: '密码已初始化,请直接登录' }
    }
    const passwordHash = await hashPassword(password)
    const initialData: AdminData = { ...DEFAULT_ADMIN_DATA, passwordHash, tokenVersion: 0 }
    const result = await createAdminData(initialData, env)
    if (!result.ok) {
      return {
        ok: false,
        error: result.exists ? '密码已初始化,请直接登录' : '初始化失败',
      }
    }
    cachedTokenVersion = 0
    tokenVersionExpiresAt = Date.now() + TOKEN_VERSION_TTL_MS
    return { ok: true }
  } catch (error) {
    logSanitizedError('setupPassword', error)
    return { ok: false, error: '初始化失败,请稍后重试' }
  }
}

export async function changePassword(
  current: string,
  next: string,
  env: Env,
): Promise<{ ok: boolean; error?: string }> {
  if (next.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `新密码至少 ${MIN_PASSWORD_LENGTH} 位` }
  }
  try {
    const valid = await verifyAdminPassword(current, env)
    if (!valid) return { ok: false, error: '当前密码错误' }

    const passwordHash = await hashPassword(next)
    const adminData = await readAdminData(env)
    adminData.passwordHash = passwordHash
    // bump tokenVersion:旧 Cookie token 的 ver 与新版本不匹配,verifyAuth 拒绝,
    // 从而在改密码后立即吊销所有已签发的 token。
    adminData.tokenVersion = (adminData.tokenVersion ?? 0) + 1
    // 先持久化再更新缓存:写库失败时若缓存已 bump,TTL 窗口内签发的新 token
    // 会在缓存从磁盘重载回旧版本后随机失效。
    await writeAdminData(adminData, env)
    cachedTokenVersion = adminData.tokenVersion
    tokenVersionExpiresAt = Date.now() + TOKEN_VERSION_TTL_MS
    return { ok: true }
  } catch (error) {
    // sha 乐观锁冲突:管理员数据已被其他操作修改,提示刷新重试。
    if (error instanceof GitHubWriteError && (error.status === 409 || error.status === 422)) {
      return { ok: false, error: '管理员数据已被其他操作修改,请刷新后重试' }
    }
    logSanitizedError('changePassword', error)
    return { ok: false, error: '修改失败,请稍后重试' }
  }
}
