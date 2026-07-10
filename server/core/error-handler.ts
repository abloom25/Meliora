/**
 * 统一错误处理工具
 * 提供安全的错误消息清理和分类功能
 */

/**
 * 错误类型分类
 */
export const ErrorType = {
  AUTHENTICATION: 'authentication',
  AUTHORIZATION: 'authorization',
  VALIDATION: 'validation',
  NETWORK: 'network',
  SYSTEM: 'system',
  UNKNOWN: 'unknown',
} as const

export type ErrorType = (typeof ErrorType)[keyof typeof ErrorType]

/**
 * 清理后的错误信息
 */
export interface SanitizedError {
  type: ErrorType
  message: string
  statusCode?: number
  safe: boolean // 是否为安全可展示的错误
}

/**
 * 错误消息映射 - 内部错误到用户友好消息的映射
 */
const ERROR_MESSAGE_MAP: Record<string, string> = {
  // 认证相关错误
  'Invalid credentials': '用户名或密码错误',
  'Token expired': '登录已过期，请重新登录',
  'Invalid token': '登录凭证无效，请重新登录',
  'CSRF token invalid': 'CSRF 令牌无效或已过期，请刷新页面重试',
  'Authentication failed': '认证失败，请重新登录',

  // 授权相关错误
  'Insufficient permissions': '权限不足，无法执行此操作',
  'Access denied': '访问被拒绝',
  Unauthorized: '未授权访问',

  // 验证相关错误
  'Validation failed': '数据验证失败，请检查输入',
  'Invalid input': '输入数据无效',
  'Missing required field': '缺少必填字段',

  // 网络相关错误
  'Network error': '网络连接失败，请检查网络设置',
  'Request timeout': '请求超时，请稍后重试',
  'Connection refused': '无法连接到服务器',

  // 系统相关错误
  'Internal server error': '服务器内部错误，请稍后重试',
  'Service unavailable': '服务暂时不可用，请稍后重试',
  'Database error': '数据存储错误',
  'File system error': '文件系统错误',

  // GitHub 相关错误
  'GitHub API error': 'GitHub API 调用失败',
  'GitHub authentication failed': 'GitHub 认证失败，请检查 Token 配置',
  'GitHub rate limit exceeded': 'GitHub API 请求过于频繁，请稍后重试',
}

/**
 * 清理错误对象，返回安全的错误信息
 * @param error 原始错误对象
 * @returns 清理后的错误信息
 */
export function sanitizeError(error: unknown): SanitizedError {
  // 如果已经是 SanitizedError，直接返回
  if (isSanitizedError(error)) {
    return error
  }

  // 处理字符串错误
  if (typeof error === 'string') {
    return {
      type: ErrorType.UNKNOWN,
      message: getSafeErrorMessage(error),
      safe: true,
    }
  }

  // 处理 Error 对象
  if (error instanceof Error) {
    return {
      type: classifyError(error),
      message: getSafeErrorMessage(error.message),
      safe: true,
    }
  }

  // 处理其他类型
  return {
    type: ErrorType.UNKNOWN,
    message: '发生未知错误',
    safe: true,
  }
}

/**
 * 清理日志输出，移除敏感信息
 * @param message 原始日志消息
 * @returns 清理后的日志消息
 */
export function sanitizeLogMessage(message: string): string {
  let sanitized = message

  // 定义敏感关键词
  const sensitivePatterns = [
    'password',
    'passwd',
    'pwd',
    'token',
    'secret',
    'key',
    'api_key',
    'apikey',
    'access_token',
    'refresh_token',
    'auth_token',
    'session',
    'authorization',
    'bearer',
  ]

  // 移除常见格式的敏感值
  for (const pattern of sensitivePatterns) {
    // 键值对格式（JSON 和类似格式）
    sanitized = sanitized.replace(
      new RegExp(`${pattern}["']?\\s*[:=]\\s*["']?[^"'\\s\\}]+["']?`, 'gi'),
      `${pattern}=[REDACTED]`,
    )
    // URL 参数格式
    sanitized = sanitized.replace(new RegExp(`${pattern}=[^&\\s]+`, 'gi'), `${pattern}=[REDACTED]`)
    // HTTP 头格式
    sanitized = sanitized.replace(
      new RegExp(`${pattern}:\\s*[^\\r\\n]+`, 'gi'),
      `${pattern}: [REDACTED]`,
    )
  }

  // 移除可能的 JWT token（eyJ 开头的标准 JWT 格式）
  sanitized = sanitized.replace(
    /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
    '[JWT_REDACTED]',
  )

  // 移除过长的字符串（可能是编码的敏感数据）
  // 32 字符以上的连续字母数字可能是 base64 编码的敏感数据
  sanitized = sanitized.replace(/\b[a-zA-Z0-9+/]{32,}={0,2}\b/g, '[LONG_STRING_REDACTED]')

  // 移除可能的敏感 URL 参数（整个查询字符串）
  sanitized = sanitized.replace(/\?[^\\s"']+/g, '?[QUERY_REDACTED]')

  // 移除 IP 地址（可能包含敏感的网络信息）
  sanitized = sanitized.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP_REDACTED]')

  return sanitized
}

/**
 * 创建安全的错误响应
 * @param error 原始错误
 * @param statusCode HTTP 状态码
 * @returns 标准化的错误响应
 */
export function createErrorResponse(
  error: unknown,
  statusCode = 500,
): {
  error: string
  type: ErrorType
  statusCode: number
} {
  const sanitized = sanitizeError(error)

  return {
    // 5xx 表示未被业务分支处理的内部异常。无论原消息长短都不应返回给客户端，
    // 详细信息只进入经过脱敏的服务端日志。
    error: statusCode >= 500 ? '服务器内部错误，请稍后重试' : sanitized.message,
    type: sanitized.type,
    statusCode,
  }
}

/**
 * 检查错误是否为 SanitizedError 类型
 */
function isSanitizedError(error: unknown): error is SanitizedError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    'message' in error &&
    'safe' in error
  )
}

/**
 * 分类错误类型
 */
function classifyError(error: Error): ErrorType {
  const message = error.message.toLowerCase()

  // 认证错误
  if (message.includes('auth') || message.includes('login') || message.includes('credential')) {
    return ErrorType.AUTHENTICATION
  }

  // 授权错误
  if (
    message.includes('permission') ||
    message.includes('access') ||
    message.includes('unauthorized')
  ) {
    return ErrorType.AUTHORIZATION
  }

  // 验证错误
  if (
    message.includes('validation') ||
    message.includes('invalid') ||
    message.includes('required')
  ) {
    return ErrorType.VALIDATION
  }

  // 网络错误
  if (
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('connection')
  ) {
    return ErrorType.NETWORK
  }

  // 系统错误
  if (
    message.includes('server') ||
    message.includes('database') ||
    message.includes('file system')
  ) {
    return ErrorType.SYSTEM
  }

  return ErrorType.UNKNOWN
}

/**
 * 获取安全的错误消息
 */
function getSafeErrorMessage(message: string): string {
  // 检查是否在映射表中
  for (const [pattern, safeMessage] of Object.entries(ERROR_MESSAGE_MAP)) {
    if (message.toLowerCase().includes(pattern.toLowerCase())) {
      return safeMessage
    }
  }

  // 没有匹配的模式，返回通用的安全消息
  if (message.length > 100) {
    return '操作失败，请稍后重试'
  }

  // 短消息可能已经比较安全，直接返回
  return message
}

/**
 * 记录错误到控制台（清理敏感信息后）
 * @param context 错误上下文
 * @param error 错误对象
 */
export function logSanitizedError(context: string, error: unknown): void {
  const sanitized = sanitizeError(error)
  const sanitizedMessage = sanitizeLogMessage(sanitized.message)

  console.error(`[${context}] ${sanitized.type}: ${sanitizedMessage}`)

  if (error instanceof Error && error.stack) {
    console.error(`[${context}] Stack trace: ${sanitizeLogMessage(error.stack)}`)
  }
}
