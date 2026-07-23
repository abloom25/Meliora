/**
 * CSRF Token 管理器
 * 负责获取、存储和使用 CSRF token 进行安全请求
 * token 仅保存在内存中(不落 localStorage),页面刷新后由 ensureCsrfToken 重新获取
 */

class CsrfManager {
  private token: string | null = null

  /**
   * 从响应头中获取并存储 CSRF token
   * @param response fetch 响应对象
   */
  public extractTokenFromResponse(response: Response): void {
    const csrfToken = response.headers.get('X-CSRF-Token')
    if (csrfToken) {
      this.token = csrfToken
    }
  }

  /**
   * 获取当前的 CSRF token
   * @returns CSRF token 或 null
   */
  public getToken(): string | null {
    return this.token
  }

  /**
   * 清除存储的 CSRF token
   */
  public clearToken(): void {
    this.token = null
  }

  /**
   * 创建包含 CSRF token 的请求头
   * @returns 请求头对象
   */
  public getRequestHeaders(): Record<string, string> {
    const token = this.getToken()
    if (!token) {
      return {}
    }

    return {
      'X-CSRF-Token': token,
    }
  }

  /**
   * 为 fetch 选项添加 CSRF token
   * @param options fetch 选项对象
   * @returns 添加了 CSRF token 的 fetch 选项
   */
  public enrichFetchOptions(options: RequestInit = {}): RequestInit {
    const csrfHeaders = this.getRequestHeaders()

    // 如果是 POST/PUT/DELETE 请求，添加 CSRF token
    if (requiresCsrfToken(options)) {
      return {
        ...options,
        headers: {
          ...options.headers,
          ...csrfHeaders,
        },
      }
    }

    return options
  }
}

// 创建全局实例
export const csrfManager = new CsrfManager()

function requiresCsrfToken(options: RequestInit): boolean {
  return options.method === 'POST' || options.method === 'PUT' || options.method === 'DELETE'
}

// 并发去重:多个写请求同时发现 token 为空时,只发起一次获取
let pendingTokenRequest: Promise<string | null> | null = null

/**
 * 确保内存中有可用的 CSRF token
 * 页面刷新后内存 token 丢失,利用仍有效的会话 Cookie 从 /api/auth 重新获取
 * (服务端对已认证的 /api/auth 请求在响应头下发新 token,与登录下发流程一致)
 * @returns 当前可用的 CSRF token 或 null
 */
export function ensureCsrfToken(): Promise<string | null> {
  const existing = csrfManager.getToken()
  if (existing) return Promise.resolve(existing)
  if (!pendingTokenRequest) {
    pendingTokenRequest = (async () => {
      try {
        const response = await fetch('/api/auth', { credentials: 'include' })
        csrfManager.extractTokenFromResponse(response)
      } catch {
        // 获取失败时保持为空,由调用方按 403 重试/报错逻辑处理
      }
      return csrfManager.getToken()
    })().finally(() => {
      pendingTokenRequest = null
    })
  }
  return pendingTokenRequest
}

/**
 * 包装 fetch 函数，自动处理 CSRF token
 * @param url 请求 URL
 * @param options fetch 选项
 * @returns fetch Promise
 */
export async function fetchWithCsrf(
  url: string | URL,
  options: RequestInit = {},
): Promise<Response> {
  // 写请求需要 token 而内存为空时(如页面刷新后),先重新获取再发请求
  if (requiresCsrfToken(options) && !csrfManager.getToken()) {
    await ensureCsrfToken()
  }

  // 添加 CSRF token 到请求头
  const enrichedOptions = csrfManager.enrichFetchOptions(options)

  // 执行请求
  const response = await fetch(url, enrichedOptions)

  // 从响应中提取新的 CSRF token
  csrfManager.extractTokenFromResponse(response)

  return response
}

/**
 * 登出时清理 CSRF token
 */
export function clearCsrfOnLogout(): void {
  csrfManager.clearToken()
}
