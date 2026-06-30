import { isDevelopmentMode, type Env } from './types'

// 密文格式版本号。升级 KDF 参数或密文结构时递增,
// 解密时按前缀选择对应算法,为算法升级留出迁移余地。
const CIPHER_VERSION = 'v1'
const CIPHER_PREFIX = `${CIPHER_VERSION}:`
const SALT_BYTES = 16
const IV_BYTES = 12
const PBKDF2_ITERATIONS = 100000

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

// 密钥原料固定使用独立的 CONFIG_ENCRYPTION_KEY,与 GH_TOKEN 完全解耦:
// GH_TOKEN 仅用于 GitHub API 读写,可独立轮换而不影响已加密的配置。
async function deriveKey(salt: Uint8Array, env: Env): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.CONFIG_ENCRYPTION_KEY),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptString(plaintext: string, env: Env): Promise<string> {
  if (isDevelopmentMode(env)) return plaintext
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKey(salt, env)
  const encoder = new TextEncoder()
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  )
  const ciphertextBytes = new Uint8Array(ciphertext)
  const combined = new Uint8Array(salt.length + iv.length + ciphertextBytes.length)
  combined.set(salt, 0)
  combined.set(iv, salt.length)
  combined.set(ciphertextBytes, salt.length + iv.length)
  return `${CIPHER_PREFIX}${bytesToBase64(combined)}`
}

export async function decryptString(stored: string, env: Env): Promise<string> {
  if (isDevelopmentMode(env)) return stored
  if (!stored.startsWith(CIPHER_PREFIX)) {
    throw new Error('Ciphertext version mismatch')
  }
  const combined = base64ToBytes(stored.slice(CIPHER_PREFIX.length))
  const salt = combined.slice(0, SALT_BYTES)
  const iv = combined.slice(SALT_BYTES, SALT_BYTES + IV_BYTES)
  const ciphertext = combined.slice(SALT_BYTES + IV_BYTES)
  const key = await deriveKey(salt, env)
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return new TextDecoder().decode(plaintext)
}

// 判断内容是否为加密密文。生产模式下写入永远加密,读取时仅接受密文;
// 明文 JSON(以 { 或 [ 开头)视为损坏或未初始化,由调用方拒绝读取。
export function looksEncrypted(content: string): boolean {
  return content.startsWith(CIPHER_PREFIX)
}
