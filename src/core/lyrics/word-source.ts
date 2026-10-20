export interface WordLyricsMetadata {
  title?: string
  artist?: string
  album?: string
}

export interface WordLyricsCandidate {
  id: number
  musicNames: readonly string[]
  artistNames: readonly string[]
  albumNames: readonly string[]
}

/** 只统一字形、大小写和空白。保留括号与 Live/Remix 等版本信息。 */
export function normalizeLyricsMetadata(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
}

function artistKey(values: readonly string[]): string {
  // 只拆明确的分隔符,不把 AC/DC、Earth, Wind & Fire 这样的艺名拆开。
  return [
    ...new Set(
      values
        .flatMap((value) => value.split(/\s+\/\s+|[、；;]/u))
        .map(normalizeLyricsMetadata)
        .filter(Boolean),
    ),
  ]
    .sort()
    .join('\u0000')
}

/** 搜索接口是模糊搜索,只有完整匹配且唯一时才自动采用。 */
export function selectWordLyricsCandidate<T extends WordLyricsCandidate>(
  candidates: readonly T[],
  query: WordLyricsMetadata,
): T | null {
  const title = normalizeLyricsMetadata(query.title)
  const artist = artistKey([query.artist ?? ''])
  const album = normalizeLyricsMetadata(query.album)
  if (!title || !artist) return null
  const matches = new Map<number, T>()
  for (const candidate of candidates) {
    if (!candidate.musicNames.some((name) => normalizeLyricsMetadata(name) === title)) continue
    if (artistKey(candidate.artistNames) !== artist) continue
    if (album && !candidate.albumNames.some((name) => normalizeLyricsMetadata(name) === album)) {
      continue
    }
    matches.set(candidate.id, candidate)
  }
  return matches.size === 1 ? (matches.values().next().value ?? null) : null
}
