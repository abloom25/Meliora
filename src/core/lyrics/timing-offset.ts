import type { LyricLine } from '../types'

/** 正数延后显示。保留负时间、词间空隙和原数组，所有显示端共用平移后的媒体时间轴。 */
export function shiftLyricTimings(lines: LyricLine[], seconds: number): LyricLine[] {
  if (!Number.isFinite(seconds) || seconds === 0) return lines
  return lines.map((line) => ({
    ...line,
    time: line.time === null ? null : line.time + seconds,
    ...(line.endTime === undefined ? {} : { endTime: line.endTime + seconds }),
    ...(line.words
      ? {
          words: line.words.map((word) => ({
            ...word,
            time: word.time + seconds,
            ...(word.syllables
              ? {
                  syllables: word.syllables.map((syllable) => ({
                    ...syllable,
                    time: syllable.time + seconds,
                  })),
                }
              : {}),
          })),
        }
      : {}),
  }))
}
