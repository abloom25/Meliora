/** Only public, static artwork from the supported music CDNs can be relayed. */
export function normalizeShareCoverUrl(raw: string): string | null {
  if (!raw || raw.length > 2048) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null
    const qq =
      url.hostname === 'y.gtimg.cn' &&
      /^\/music\/photo_new\/[\w.-]+\.(jpg|png|webp)$/i.test(url.pathname)
    const netease =
      /^p[1-9]\d?\.music\.126\.net$/.test(url.hostname) &&
      /^\/[\w=-]+\/\d+\.(jpg|jpeg|png|webp)$/i.test(url.pathname)
    if (!qq && !netease) return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

export const DEV_SHARE_COVER_PATH = '/__meliora-dev/cover'

export function shareCoverFallbackUrl(cover: string, development = false): string | null {
  const url = normalizeShareCoverUrl(cover)
  if (!url) return null
  return `${development ? DEV_SHARE_COVER_PATH : '/api/cover'}?url=${encodeURIComponent(url)}`
}
