import { describe, expect, it } from 'vitest'
import { encryptString, decryptString, looksEncrypted } from '../core/crypto'
import { validateEncryptionKey } from '../core/types'
import type { Env } from '../core/types'

const PLAINTEXT = '{"siteName":"Meliora","apiToken":"secret"}'
const STRONG_KEY = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6'

function envWith(encKey: string, token = 'real-gh-token'): Env {
  return {
    GH_TOKEN: token,
    GH_REPO: 'test/repo',
    GH_BRANCH: 'main',
    CONFIG_ENCRYPTION_KEY: encKey,
  }
}

describe('crypto: key decoupling', () => {
  it('encrypts and decrypts with CONFIG_ENCRYPTION_KEY', async () => {
    const env = envWith(STRONG_KEY)
    const ciphertext = await encryptString(PLAINTEXT, env)
    expect(looksEncrypted(ciphertext)).toBe(true)
    const decrypted = await decryptString(ciphertext, env)
    expect(decrypted).toBe(PLAINTEXT)
  })

  it('survives GH_TOKEN rotation when CONFIG_ENCRYPTION_KEY unchanged', async () => {
    const envBefore = envWith(STRONG_KEY, 'gh-token-old')
    const ciphertext = await encryptString(PLAINTEXT, envBefore)

    // GH_TOKEN 轮换(独立密钥不变),配置仍可解密 —— 密钥解耦的核心目标
    const envAfter = envWith(STRONG_KEY, 'gh-token-new')
    expect(await decryptString(ciphertext, envAfter)).toBe(PLAINTEXT)
  })

  it('cannot decrypt after CONFIG_ENCRYPTION_KEY rotation (expected, needs re-init)', async () => {
    const envBefore = envWith(STRONG_KEY)
    const ciphertext = await encryptString(PLAINTEXT, envBefore)

    // CONFIG_ENCRYPTION_KEY 轮换后旧密文不可解密(预期:需重新初始化配置)
    const envAfter = envWith('z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2h1g0f9e8d7c6b5a4')
    await expect(decryptString(ciphertext, envAfter)).rejects.toThrow()
  })

  it('produces different ciphertexts for same plaintext (random salt+iv)', async () => {
    const env = envWith(STRONG_KEY)
    const a = await encryptString(PLAINTEXT, env)
    const b = await encryptString(PLAINTEXT, env)
    expect(a).not.toBe(b)
    expect(await decryptString(a, env)).toBe(PLAINTEXT)
    expect(await decryptString(b, env)).toBe(PLAINTEXT)
  })

  it('looksEncrypted detects v1 prefix only', () => {
    expect(looksEncrypted('v1:YWJjZA==')).toBe(true)
    expect(looksEncrypted('{"siteName":"Meliora"}')).toBe(false)
    expect(looksEncrypted('')).toBe(false)
    expect(looksEncrypted('plain-base64-without-prefix')).toBe(false)
  })
})

describe('validateEncryptionKey', () => {
  it('accepts a strong 32+ char key in production mode', () => {
    expect(validateEncryptionKey(envWith(STRONG_KEY)).ok).toBe(true)
  })

  it('rejects empty key in production mode', () => {
    const result = validateEncryptionKey(envWith(''))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('未设置')
  })

  it('rejects key shorter than 32 chars', () => {
    const result = validateEncryptionKey(envWith('shortkey-only-28-chars-long'))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('强度不足')
  })

  it('rejects all-same-char key', () => {
    const result = validateEncryptionKey(envWith('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('简单')
  })

  it('rejects sequential key', () => {
    const result = validateEncryptionKey(envWith('abcdefghijklmnopqrstuvwxyz123456'))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('简单')
  })

  it('skips validation in local mode', () => {
    const localEnv: Env = {
      GH_TOKEN: 'placeholder',
      GH_REPO: 'test/repo',
      GH_BRANCH: 'main',
      CONFIG_ENCRYPTION_KEY: '',
    }
    expect(validateEncryptionKey(localEnv).ok).toBe(true)
  })
})
