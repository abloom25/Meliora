import { LruCache } from '../util/lru-cache'

export interface DisplayTitle {
  title: string
  versions: string[]
  version?: string
}

const titleCache = new LruCache<string, DisplayTitle>(256)

export function splitDisplayTitle(rawTitle: string): DisplayTitle {
  if (titleCache.has(rawTitle)) return titleCache.get(rawTitle)!

  let title = rawTitle.trim()
  const versions: string[] = []

  while (title.endsWith(')') || title.endsWith('）')) {
    const closing = title.at(-1)
    const opening = closing === '）' ? '（' : '('
    let depth = 0
    let openingIndex = -1
    for (let index = title.length - 1; index >= 0; index -= 1) {
      const char = title[index]
      if (char === closing) {
        depth += 1
        continue
      }
      if (char !== opening) continue

      depth -= 1
      if (depth !== 0) continue
      openingIndex = index
      break
    }

    if (openingIndex < 0) break

    const mainTitle = title.slice(0, openingIndex).trim()
    const version = title.slice(openingIndex + 1, -1).trim()
    if (!mainTitle || !version) break

    versions.unshift(version)
    title = mainTitle
  }

  const result: DisplayTitle = {
    title,
    versions,
    version: versions[0],
  }
  titleCache.set(rawTitle, result)
  return result
}
