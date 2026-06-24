import { describe, expect, it } from 'vitest'
import { signToken, verifyToken, timingSafeEqual, getSigningSecret } from '../core/auth'
import type { Env } from '../core/types'

const TEST_ENV: Env = {
  GH_TOKEN: 'placeholder',
  GH_REPO: 'test/repo',
  GH_BRANCH: 'main',
  CONFIG_ENCRYPTION_KEY: '',
}
const ENV_A: Env = {
  GH_TOKEN: 'real-token-a',
  GH_REPO: 'test/repo',
  GH_BRANCH: 'main',
  CONFIG_ENCRYPTION_KEY: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6',
}
const ENV_B: Env = {
  GH_TOKEN: 'real-token-b',
  GH_REPO: 'test/repo',
  GH_BRANCH: 'main',
  CONFIG_ENCRYPTION_KEY: 'z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2h1g0f9e8d7c6b5a4',
}

describe('admin auth', () => {
  it('signs and verifies a valid token', async () => {
    const secret = await getSigningSecret(TEST_ENV)
    const token = await signToken(TEST_ENV)
    expect(token).toBeTruthy()
    expect(token.split('.')).toHaveLength(2)

    const valid = await verifyToken(token, secret, 0)
    expect(valid).toBe(true)
  })

  it('rejects an expired token', async () => {
    const secret = await getSigningSecret(TEST_ENV)
    const token = await signToken(TEST_ENV, -1000)
    const valid = await verifyToken(token, secret, 0)
    expect(valid).toBe(false)
  })

  it('rejects a tampered token', async () => {
    const secret = await getSigningSecret(TEST_ENV)
    const token = await signToken(TEST_ENV)
    const parts = token.split('.')
    const tampered = `${parts[0]}.invalid-signature`
    const valid = await verifyToken(tampered, secret, 0)
    expect(valid).toBe(false)
  })

  it('rejects a token signed with a different secret', async () => {
    const secretB = await getSigningSecret(ENV_B)
    const token = await signToken(ENV_A)
    const valid = await verifyToken(token, secretB, 0)
    expect(valid).toBe(false)
  })

  it('rejects empty or malformed tokens', async () => {
    const secret = await getSigningSecret(TEST_ENV)
    expect(await verifyToken('', secret, 0)).toBe(false)
    expect(await verifyToken('malformed', secret, 0)).toBe(false)
    expect(await verifyToken('a.b.c', secret, 0)).toBe(false)
  })

  it('rejects a token with mismatched token version', async () => {
    const secret = await getSigningSecret(TEST_ENV)
    const token = await signToken(TEST_ENV)
    // ver=0 签发,期望 ver=1 应被拒绝(模拟 changePassword 后旧 token 失效)
    const valid = await verifyToken(token, secret, 1)
    expect(valid).toBe(false)
  })

  it('timingSafeEqual returns true for equal strings', () => {
    expect(timingSafeEqual('password', 'password')).toBe(true)
  })

  it('timingSafeEqual returns false for different strings', () => {
    expect(timingSafeEqual('password', 'wrong')).toBe(false)
  })

  it('timingSafeEqual returns false for different lengths', () => {
    expect(timingSafeEqual('short', 'longer-string')).toBe(false)
  })
})
