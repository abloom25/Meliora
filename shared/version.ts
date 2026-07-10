export interface ParsedSemver {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function normalizeVersionTag(version: string): string {
  return version
    .trim()
    .replace(/^refs\/tags\//, '')
    .replace(/^v/i, '')
}

export function parseSemver(version: string): ParsedSemver | null {
  const normalized = normalizeVersionTag(version)
  const match = normalized.match(SEMVER_PATTERN)
  if (!match) return null

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

export function isSemver(version: string): boolean {
  return parseSemver(version) !== null
}

export function isPrereleaseVersion(version: string): boolean {
  return (parseSemver(version)?.prerelease.length ?? 0) > 0
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)

  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left.localeCompare(right)
}

export function compareSemver(leftVersion: string, rightVersion: string): number {
  const left = parseSemver(leftVersion)
  const right = parseSemver(rightVersion)
  if (!left || !right) return 0

  const stableDiff =
    left.major - right.major || left.minor - right.minor || left.patch - right.patch
  if (stableDiff !== 0) return stableDiff

  if (!left.prerelease.length && !right.prerelease.length) return 0
  if (!left.prerelease.length) return 1
  if (!right.prerelease.length) return -1

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let i = 0; i < length; i += 1) {
    const leftPart = left.prerelease[i]
    const rightPart = right.prerelease[i]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const partDiff = comparePrereleaseIdentifier(leftPart, rightPart)
    if (partDiff !== 0) return partDiff
  }

  return 0
}

export function shouldOfferUpdate(
  latestVersion: string,
  currentVersion: string,
  options: { includePrerelease?: boolean } = {},
): boolean {
  if (!isSemver(latestVersion) || !isSemver(currentVersion)) return false
  if (!options.includePrerelease && isPrereleaseVersion(latestVersion)) {
    return false
  }
  return compareSemver(latestVersion, currentVersion) > 0
}

export function selectLatestVersion<T>(
  items: T[],
  getVersion: (item: T) => string | undefined,
  options: { includePrerelease: boolean },
): T | null {
  let selected: T | null = null
  let selectedVersion = ''

  for (const item of items) {
    const version = getVersion(item)
    if (!version || !isSemver(version)) continue
    if (!options.includePrerelease && isPrereleaseVersion(version)) continue

    if (!selected || compareSemver(version, selectedVersion) > 0) {
      selected = item
      selectedVersion = version
    }
  }

  return selected
}
