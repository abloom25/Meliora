interface LyricsCacheEntry {
  promise: Promise<string>
  ready: boolean
}

const lyricsCache = new Map<string, LyricsCacheEntry>()

export function loadLyricsText(url: string): Promise<string> {
  const existing = lyricsCache.get(url)
  if (existing) return existing.promise

  const entry: LyricsCacheEntry = {
    ready: false,
    promise: Promise.resolve(''),
  }
  entry.promise = fetch(url, { cache: 'force-cache' })
    .then((response) => {
      if (!response.ok) throw new Error('Lyrics request failed')
      return response.text()
    })
    .then((text) => {
      entry.ready = true
      return text
    })
    .catch((error) => {
      lyricsCache.delete(url)
      throw error
    })

  lyricsCache.set(url, entry)
  return entry.promise
}

export function hasCachedLyrics(url: string): boolean {
  return lyricsCache.get(url)?.ready ?? false
}
