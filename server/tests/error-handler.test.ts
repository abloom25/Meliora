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

  it('redacts entire query strings, including values containing the letter s', () => {
    const message = sanitizeLogMessage('GET /api/callback?session_id=abc123sig HTTP/1.1')

    expect(message).toContain('?[QUERY_REDACTED]')
    expect(message).not.toContain('abc123sig')
    // 脱敏必须停在空白处,不能吞掉查询串之后的日志文本
    expect(message).toContain('HTTP/1.1')
  })
})
