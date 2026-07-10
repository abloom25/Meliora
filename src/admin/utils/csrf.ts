/**
 * CSRF Token 管理器
 * 负责获取、存储和使用 CSRF token 进行安全请求
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
      // 也可以存储到 localStorage 作为备用
      try {
        localStorage.setItem(CSRF_CONSTANTS.STORAGE_KEY, csrfToken)
      } catch {
        // localStorage 不可用时忽略
      }
    }
  }

  /**
   * 获取当前的 CSRF token
   * @returns CSRF token 或 null
   */
  public getToken(): string | null {
    if (this.token) {
      return this.token
    }

    // 尝试从 localStorage 获取
    try {
      const storedToken = localStorage.getItem(CSRF_CONSTANTS.STORAGE_KEY)
      if (storedToken) {
        this.token = storedToken
        return storedToken
      }
    } catch {
      // localStorage 不可用时忽略
    }

    return null
  }

  /**
   * 清除存储的 CSRF token
   */
  public clearToken(): void {
    this.token = null
    try {
      localStorage.removeItem(CSRF_CONSTANTS.STORAGE_KEY)
    } catch {
      // localStorage 不可用时忽略
    }
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
    if (options.method === 'POST' || options.method === 'PUT' || options.method === 'DELETE') {
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
import { CSRF_CONSTANTS } from '../../../shared/constants'
