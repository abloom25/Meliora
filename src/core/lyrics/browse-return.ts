/** Reading time grows with distance, bounded so playback following always resumes. */
export function lyricBrowseDelay(distanceScreens: number): number {
  const distance = Number.isFinite(distanceScreens) ? Math.max(0, distanceScreens) : 0
  return 2600 + Math.min(3, distance) * 1000
}

export function lyricBrowseReturnWait(
  elapsedMs: number,
  distanceScreens: number,
  coasting: boolean,
): number {
  if (coasting) return 250
  return Math.max(0, lyricBrowseDelay(distanceScreens) - Math.max(0, elapsedMs))
}

export function lyricBrowseReturnStiffness(distanceScreens: number): number {
  const distance = Number.isFinite(distanceScreens) ? Math.max(0, distanceScreens) : 0
  return 100 / (1 + Math.min(3, distance) * 0.15)
}
