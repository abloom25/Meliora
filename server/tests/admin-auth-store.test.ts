import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../core/types'

const STRONG_KEY = 'meliora-prod-key-A7f3N9q2R8s5T1u4V6w0'

// 开发模式走 admin-auth-store 的内存路径,无需 mock GitHub IO。
const DEV_ENV: Env = {
  GH_TOKEN: 'placeholder',
  GH_REPO: 'owner/repo',
  GH_BRANCH: 'main',
  CONFIG_ENCRYPTION_KEY: '',
  DEVELOPMENT: 'true',
}

const PROD_ENV: Env = {
  GH_TOKEN: 'ghp_real_token_for_test',
  GH_REPO: 'owner/repo',
  GH_BRANCH: 'main',
  CONFIG_ENCRYPTION_KEY: STRONG_KEY,
}

const githubMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock('../core/github', async (importOriginal) => {
  const original = await importOriginal<typeof import('../core/github')>()
  return {
    ...original,
    readFile: githubMocks.readFile,
    writeFile: githubMocks.writeFile,
  }
})

describe('admin-auth-store', () => {
  beforeEach(() => {
    // admin-auth-store 持有模块级内存缓存(localAdminCache / tokenVersion 缓存),
    // 每个用例重建模块实例以隔离状态。
    vi.resetModules()
    githubMocks.readFile.mockReset()
    githubMocks.writeFile.mockReset()
  })

  it('hashes and verifies a password roundtrip', async () => {
    const { hashPassword, verifyPassword } = await import('../core/admin-auth-store')

    const stored = await hashPassword('correct-horse-battery')

    expect(stored.startsWith('pbkdf2$')).toBe(true)
    expect(await verifyPassword('correct-horse-battery', stored)).toBe(true)
  })

  it('rejects a wrong password and malformed stored hashes', async () => {
    const { hashPassword, verifyPassword } = await import('../core/admin-auth-store')

    const stored = await hashPassword('correct-horse-battery')

    expect(await verifyPassword('wrong-password', stored)).toBe(false)
    expect(await verifyPassword('correct-horse-battery', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('correct-horse-battery', '')).toBe(false)
  })

  it('rejects repeated setupPassword initialization', async () => {
    const { setupPassword, isInitialized, verifyAdminPassword } =
      await import('../core/admin-auth-store')

    const first = await setupPassword('first-password', DEV_ENV)
    expect(first.ok).toBe(true)
    expect(await isInitialized(DEV_ENV)).toBe(true)

    const second = await setupPassword('second-password', DEV_ENV)
    expect(second.ok).toBe(false)
    expect(second.error).toContain('已初始化')
    expect(await verifyAdminPassword('first-password', DEV_ENV)).toBe(true)
    expect(await verifyAdminPassword('second-password', DEV_ENV)).toBe(false)
  })

  it('bumps the token version on changePassword and invalidates old-version tokens', async () => {
    const { setupPassword, changePassword, getTokenVersion } =
      await import('../core/admin-auth-store')
    const { signToken, verifyToken, getSigningSecret } = await import('../core/auth')

    const setup = await setupPassword('initial-password', DEV_ENV)
    expect(setup.ok).toBe(true)
    expect(await getTokenVersion(DEV_ENV)).toBe(0)

    const secret = await getSigningSecret(DEV_ENV)
    const oldToken = await signToken(DEV_ENV)
    expect(await verifyToken(oldToken, secret, await getTokenVersion(DEV_ENV))).toBe(true)

    const result = await changePassword('initial-password', 'updated-password', DEV_ENV)
    expect(result.ok).toBe(true)
    expect(await getTokenVersion(DEV_ENV)).toBe(1)
    expect(await verifyToken(oldToken, secret, await getTokenVersion(DEV_ENV))).toBe(false)
  })

  it('does not bump the token version when the current password is wrong', async () => {
    const { setupPassword, changePassword, getTokenVersion, verifyAdminPassword } =
      await import('../core/admin-auth-store')

    const setup = await setupPassword('initial-password', DEV_ENV)
    expect(setup.ok).toBe(true)
    const versionBefore = await getTokenVersion(DEV_ENV)

    const result = await changePassword('wrong-current', 'updated-password', DEV_ENV)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('当前密码错误')
    expect(await getTokenVersion(DEV_ENV)).toBe(versionBefore)
    expect(await verifyAdminPassword('initial-password', DEV_ENV)).toBe(true)
    expect(await verifyAdminPassword('updated-password', DEV_ENV)).toBe(false)
  })

  it('fails closed when production admin.json is plaintext', async () => {
    githubMocks.readFile.mockResolvedValue({
      content: JSON.stringify({ passwordHash: 'pbkdf2$1$c2FsdA==$aGFzaA==', tokenVersion: 0 }),
      sha: 'sha',
    })
    const { isInitialized, setupPassword } = await import('../core/admin-auth-store')

    // 明文 admin.json 必须视为损坏并抛错,而非当作未初始化返回空对象,
    // 否则 isInitialized 误判为 false 会重新开放 /setup,导致管理员密码被接管。
    await expect(isInitialized(PROD_ENV)).rejects.toThrow('admin.json is not encrypted')

    const result = await setupPassword('brand-new-password', PROD_ENV)
    expect(result.ok).toBe(false)
    expect(githubMocks.writeFile).not.toHaveBeenCalled()
  })
})
