import { afterEach, describe, expect, it, vi } from 'vitest'
import { CSRF_CONSTANTS } from '../../shared/constants'
import {
  extractCsrfToken,
  generateCsrfToken,
  validateCsrfRequest,
  verifyCsrfToken,
} from '../core/csrf'
import type { Env } from '../core/types'

const tokenVersionState = vi.hoisted(() => ({ value: 0 }))

vi.mock('../core/admin-auth-store', () => ({
  getTokenVersion: () => Promise.resolve(tokenVersionState.value),
}))

const SECRET = 'csrf-test-secret-with-sufficient-entropy'
const ENV: Env = {
  GH_TOKEN: 'placeholder',
  GH_REPO: 'owner/repo',
  GH_BRANCH: 'main',
  CONFIG_ENCRYPTION_KEY: '',
  DEVELOPMENT: 'true',
}

describe('CSRF tokens', () => {
  afterEach(() => {
    vi.useRealTimers()
    tokenVersionState.value = 0
  })

  it('accepts a freshly generated token', async () => {
    const token = await generateCsrfToken(SECRET)

    await expect(verifyCsrfToken(token, SECRET)).resolves.toBe(true)
    await expect(
      validateCsrfRequest(
        new Request('https://example.com/api/config', {
          method: 'PUT',
          headers: { 'X-CSRF-Token': token },
        }),
        SECRET,
      ),
    ).resolves.toBe(true)
  })

  it('rejects tampered and expired tokens', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'))
    const token = await generateCsrfToken(SECRET)
    const tampered = `${token.startsWith('a') ? 'b' : 'a'}${token.slice(1)}`

    await expect(verifyCsrfToken(tampered, SECRET)).resolves.toBe(false)

    vi.advanceTimersByTime(CSRF_CONSTANTS.MAX_AGE + 1)
    await expect(verifyCsrfToken(token, SECRET)).resolves.toBe(false)
  })

  it('does not accept a token supplied only through cookies', async () => {
    const token = await generateCsrfToken(SECRET)
    const request = new Request('https://example.com/api/config', {
      method: 'PUT',
      headers: { Cookie: `meliora_csrf=${token}` },
    })

    expect(extractCsrfToken(request)).toBeNull()
    await expect(validateCsrfRequest(request, SECRET)).resolves.toBe(false)
  })

  it('invalidates previously issued tokens when the token version changes', async () => {
    tokenVersionState.value = 1
    const token = await generateCsrfToken(SECRET, ENV)
    const requestWithToken = () =>
      new Request('https://example.com/api/config', {
        method: 'PUT',
        headers: { 'X-CSRF-Token': token },
      })

    await expect(verifyCsrfToken(token, SECRET, ENV)).resolves.toBe(true)
    await expect(validateCsrfRequest(requestWithToken(), SECRET, ENV)).resolves.toBe(true)

    // 改密码 bump tokenVersion 后,旧 CSRF token 立即失效
    tokenVersionState.value = 2
    await expect(verifyCsrfToken(token, SECRET, ENV)).resolves.toBe(false)
    await expect(validateCsrfRequest(requestWithToken(), SECRET, ENV)).resolves.toBe(false)

    // 新版本签发的 token 不受影响
    const freshToken = await generateCsrfToken(SECRET, ENV)
    await expect(verifyCsrfToken(freshToken, SECRET, ENV)).resolves.toBe(true)
  })
})
