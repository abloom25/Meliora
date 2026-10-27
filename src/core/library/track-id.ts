/** Persistent track IDs are independent of playlist position and display metadata. */
const STABLE_METING_PREFIX = 'meting:v2:'

function decodeQuery(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' ')).trim()
  } catch {
    return ''
  }
}

function resourceParameters(resource: string): Map<string, string[]> {
  const params = new Map<string, string[]>()
  const query = resource.split('#', 1)[0]!.split('?').slice(1).join('?')
  for (const pair of query.split('&')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    const key = decodeQuery(pair.slice(0, separator)).toLowerCase()
    const value = decodeQuery(pair.slice(separator + 1))
    if (!key || !value) continue
    params.set(key, [...(params.get(key) ?? []), value])
  }
  return params
}

function singleParameter(params: Map<string, string[]>, name: string): string | null {
  const values = [...new Set(params.get(name) ?? [])]
  return values.length === 1 ? values[0]! : null
}

function platformName(source: string): string {
  const platform = source.split(':', 1)[0]!.toLowerCase()
  return platform === 'qq' ? 'tencent' : platform
}

function songIdentity(source: string, resource: string): string | null {
  const params = resourceParameters(resource)
  const server = singleParameter(params, 'server')
  if (params.has('server') && !server) return null
  const platform = platformName(server ?? source)
  if (platform !== 'netease' && platform !== 'tencent') return null
  const type = singleParameter(params, 'type')
  if (params.has('type') && (!type || !['url', 'lrc', 'lyric', 'song', 'music'].includes(type)))
    return null
  // A CDN's generic ?id= value need not be a platform song ID. Only accept a
  // declared platform, a Meting resource type, or a recognizable song endpoint.
  if (!server && !type && !/\/(?:song|music)\/(?:url|lyric)(?:[/?#]|$)/i.test(resource)) return null
  const id = singleParameter(params, 'songmid') ?? singleParameter(params, 'id')
  if (!id || id.length > 512) return null
  // NetEase IDs are numeric; custom APIs may also expose stable opaque IDs.
  // Keep their exact value rather than treating filenames/titles as a song ID.
  try {
    return `${STABLE_METING_PREFIX}${platform}:song:${encodeURIComponent(id)}`
  } catch {
    return null
  }
}

/** Audio identity takes precedence when a provider reuses lyrics for multiple recordings. */
export function createMetingTrackId(source: string, audioUrl: string, lyricsUrl?: string): string {
  const audio = audioUrl.trim()
  const song =
    songIdentity(source, audio) ?? (lyricsUrl ? songIdentity(source, lyricsUrl.trim()) : null)
  if (song) return song
  // No inference about signed query parameters: different resource URLs can be
  // different live/remix recordings. Only the fragment is never sent to a server.
  const resource = audio.split('#', 1)[0]!
  return `${STABLE_METING_PREFIX}${encodeURIComponent(platformName(source))}:resource:${resource}`
}

/** Normalize persisted pre-v2 IDs without requiring a loaded playlist or browser URL APIs. */
export function normalizeTrackId(id: string): string {
  if (!id.startsWith('meting:') || id.startsWith(STABLE_METING_PREFIX)) return id
  const legacy = /^meting:(netease|tencent):([^:]*):\d+:([\s\S]+)$/.exec(id)
  return legacy ? createMetingTrackId(`${legacy[1]}:${legacy[2]}`, legacy[3]!) : id
}
