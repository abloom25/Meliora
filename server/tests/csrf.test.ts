import { afterEach, describe, expect, it, vi } from 'vitest'
import { CSRF_CONSTANTS } from '../../shared/constants'
import {
  extractCsrfToken,
  generateCsrfToken,
  validateCsrfRequest,
  verifyCsrfToken,
} from '../core/csrf'

const SECRET = 'csrf-test-secret-with-sufficient-entropy'

describe('CSRF tokens', () => {
  afterEach(() => {
    vi.useRealTimers()
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
})
