import { describe, expect, it } from 'vitest'
import { createErrorResponse, sanitizeLogMessage } from '../core/error-handler'

describe('server error handling', () => {
  it('does not expose short internal exception messages in 5xx responses', () => {
    const response = createErrorResponse(
      new Error('repository path owner/private-repo failed'),
      500,
    )

    expect(response.error).toBe('服务器内部错误，请稍后重试')
    expect(response.error).not.toContain('private-repo')
  })

  it('redacts common credentials from diagnostic log messages', () => {
    const message = sanitizeLogMessage('token=secret-value password=hunter2')

    expect(message).not.toContain('secret-value')
    expect(message).not.toContain('hunter2')
  })
})
