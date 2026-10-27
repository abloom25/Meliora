/** Reject corrupt links before their time can become a pending media seek. */
export const MAX_TRACK_SHARE_SECONDS = 24 * 60 * 60

export function formatTrackShareTime(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_TRACK_SHARE_SECONDS) return null
  return String(Math.round(seconds * 1000) / 1000)
}

export function parseTrackShareTime(value: string | null | undefined): number | null {
  if (!value || value.length > 32 || !/^\d+(?:\.\d+)?$/.test(value)) return null
  const formatted = formatTrackShareTime(Number(value))
  return formatted === null ? null : Number(formatted)
}
