export interface LyricLayoutWord {
  text: string
  width: number
  gap: number
}

const segmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null
const CLOSING = /^[,.;:!?，。；：！？、）】》」』’”]/u
const OPENING = /[（【《「『‘“]$/u
const PUNCTUATION = /[,.;:!?，。；：！？、]$/u

/**
 * Preserve whole display words and the minimum natural line count, then balance those rows.
 * Break costs favour spaces/punctuation and avoid separating a CJK phrase or its punctuation.
 * Runs on layout changes only. Very long malformed lines use bounded greedy wrapping.
 */
export function balanceLyricBreaks(words: readonly LyricLayoutWord[], available: number): number[] {
  if (words.length < 2 || !Number.isFinite(available) || available <= 0) return []
  const count = words.length
  const prefix = [0]
  for (const word of words)
    prefix.push(prefix.at(-1)! + Math.max(0, word.width) + Math.max(0, word.gap))
  const width = (start: number, end: number) =>
    prefix[end]! - prefix[start]! - Math.max(0, words[end - 1]!.gap)
  const greedy: number[] = []
  let start = 0
  for (let end = 1; end <= count; end += 1) {
    if (end > start + 1 && width(start, end) > available + 0.5) {
      greedy.push(end - 1)
      start = end - 1
    }
  }
  if (!greedy.length || count > 256) return greedy
  const rows = greedy.length + 1
  const fullText = words.map((word) => word.text + (word.gap > 0 ? ' ' : '')).join('')
  const boundaries = new Set<number>()
  if (segmenter) {
    for (const part of segmenter.segment(fullText)) boundaries.add(part.index)
  }
  const offsets = [0]
  for (const word of words) offsets.push(offsets.at(-1)! + word.text.length + Number(word.gap > 0))
  const ideal = prefix[count]! / rows
  const costs = Array.from({ length: rows + 1 }, () => new Float64Array(count + 1).fill(Infinity))
  const previous = Array.from({ length: rows + 1 }, () => new Int32Array(count + 1).fill(-1))
  costs[0]![0] = 0
  for (let row = 1; row <= rows; row += 1) {
    for (let end = row; end <= count; end += 1) {
      for (let begin = end - 1; begin >= row - 1; begin -= 1) {
        const length = width(begin, end)
        if (length > available + 0.5 && end > begin + 1) break
        const left = words[end - 1]!
        const right = words[end]
        let penalty = 0
        if (right) {
          if (CLOSING.test(right.text) || OPENING.test(left.text)) penalty = available ** 2 * 4
          else if (PUNCTUATION.test(left.text) || left.gap > 0) penalty = 0
          else if (boundaries.has(offsets[end]!)) penalty = available ** 2 * 0.02
          else penalty = available ** 2 * 0.15
        }
        const cost = costs[row - 1]![begin]! + (length - ideal) ** 2 + penalty
        if (cost < costs[row]![end]!) {
          costs[row]![end] = cost
          previous[row]![end] = begin
        }
      }
    }
  }
  const breaks: number[] = []
  let end = count
  for (let row = rows; row > 0; row -= 1) {
    const begin = previous[row]![end]!
    if (begin < 0) return greedy
    if (begin > 0) breaks.push(begin)
    end = begin
  }
  return breaks.reverse()
}
