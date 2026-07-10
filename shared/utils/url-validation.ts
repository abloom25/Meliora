/**
 * 共享的 URL 验证工具函数
 * 提供公网 URL 验证、SSRF 防护等功能
 */

/**
 * 判断 IPv6 主机是否被阻止
 * @param host IPv6 主机地址
 * @returns 是否应该被阻止
 */
function isBlockedIpv6Host(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fe80:')) return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  // IPv4-mapped IPv6 can hide private IPv4 targets after URL normalization
  // (for example [::ffff:127.0.0.1] -> [::ffff:7f00:1]).
  if (normalized.startsWith('::ffff:')) return true
  return false
}

/**
 * 判断 URL 是否为公网 http(s) 地址
 * 用于防止管理员将 apiEndpoint 指向内网/元数据端点
 * 造成 SSRF (如 169.254.169.254 云元数据、localhost、私有网段)。
 * Edge Runtime 无法做 DNS 反查，此处仅做 hostname 字面量校验，可挡住直接 IP 型 SSRF。
 * @param raw URL 字符串
 * @returns 是否为有效的公网 http(s) URL
 */
export function isPublicHttpUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host.endsWith('.local')) return false

  // IPv4 字面量:拒绝所有私有/保留/链路本地/环回/元数据网段
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    const parts = host.split('.').map(Number)
    if (parts.some((p) => p > 255)) return false
    const [a, b] = parts
    if (a === 0) return false
    if (a === 10) return false
    if (a === 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a >= 224) return false // 组播(224-239)与保留(240+)
    return true
  }

  // IPv6 字面量:拒绝环回、链路本地、唯一本地地址
  if (host.startsWith('[')) {
    if (isBlockedIpv6Host(host)) return false
    return true
  }

  return true
}

/**
 * 判断 URL 是否为公网 https 地址
 * @param raw URL 字符串
 * @returns 是否为有效的公网 https URL
 */
export function isPublicHttpsUrl(raw: string): boolean {
  if (!isPublicHttpUrl(raw)) return false
  try {
    return new URL(raw.trim()).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 检查主机是否为环回地址
 * @param origin 源地址
 * @returns 是否为环回地址
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname, protocol } = new URL(origin)
    return (
      protocol === 'http:' &&
      (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')
    )
  } catch {
    return false
  }
}

/**
 * 判断 URL 是否为有效的 http(s) URL（包括内网地址）
 * 用于基本格式验证，不限制是否为公网地址
 * @param raw URL 字符串
 * @returns 是否为有效的 http(s) URL
 */
export function isValidUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
