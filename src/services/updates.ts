import { APP_VERSION } from '../generated/app-version'
import { safeStorage } from '../utils/storage'

interface GitHubRelease {
  html_url?: string
  tag_name?: string
}

interface GitHubTag {
  name?: string
}

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  url: string
}

interface CachedLatest {
  latestVersion: string
  url: string
}

interface UpdateCacheEntry {
  fetchedAt: number
  latest: CachedLatest | null
}

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const REPOSITORY = 'abloom25/Meliora'
const UPDATE_CACHE_KEY = 'meliora:update-cache'
const UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const GITHUB_FETCH_TIMEOUT_MS = 8000

function normalizeVersion(version: string) {
  return version
    .trim()
    .replace(/^refs\/tags\//, '')
    .replace(/^v/i, '')
}

function isComparableVersion(version: string) {
  const normalized = normalizeVersion(version)
  return normalized.length > 0
}

function parseVersion(version: string): ParsedVersion | null {
  const normalized = normalizeVersion(version).replace(/\+.*$/, '')
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (!match) return null

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)

  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left.localeCompare(right)
}

function compareVersions(leftVersion: string, rightVersion: string): number {
  const left = parseVersion(leftVersion)
  const right = parseVersion(rightVersion)
  if (!left || !right) {
    return normalizeVersion(leftVersion).localeCompare(normalizeVersion(rightVersion))
  }

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

function isNewerVersion(latestVersion: string, currentVersion: string) {
  return compareVersions(latestVersion, currentVersion) > 0
}

function composeTimeoutSignal(signal: AbortSignal | undefined): {
  signal: AbortSignal
  cleanup: () => void
} {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS)

  const forwardAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason)
    } else {
      signal.addEventListener('abort', forwardAbort, { once: true })
    }
  }

  const cleanup = () => {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', forwardAbort)
  }

  return { signal: controller.signal, cleanup }
}

function readUpdateCache(): UpdateCacheEntry | null {
  const raw = safeStorage.getItem(UPDATE_CACHE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as UpdateCacheEntry
  } catch {
    return null
  }
}

function writeUpdateCache(latest: CachedLatest | null): void {
  safeStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), latest }))
}

async function fetchLatestRelease(signal?: AbortSignal): Promise<UpdateInfo | null> {
  const { signal: composedSignal, cleanup } = composeTimeoutSignal(signal)
  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: composedSignal,
    })
    if (!response.ok) return null
    const release = (await response.json()) as GitHubRelease
    if (!release.tag_name) return null
    return {
      currentVersion: APP_VERSION,
      latestVersion: release.tag_name,
      url: release.html_url || `https://github.com/${REPOSITORY}/releases/tag/${release.tag_name}`,
    }
  } finally {
    cleanup()
  }
}

async function fetchLatestTag(signal?: AbortSignal): Promise<UpdateInfo | null> {
  const { signal: composedSignal, cleanup } = composeTimeoutSignal(signal)
  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/tags?per_page=1`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: composedSignal,
    })
    if (!response.ok) return null
    const tags = (await response.json()) as GitHubTag[]
    const tag = tags[0]?.name
    if (!tag) return null
    return {
      currentVersion: APP_VERSION,
      latestVersion: tag,
      url: `https://github.com/${REPOSITORY}/releases/tag/${tag}`,
    }
  } finally {
    cleanup()
  }
}

export async function checkForUpdate(
  signal?: AbortSignal,
  forceRefresh = false,
): Promise<UpdateInfo | null> {
  if (!import.meta.env.PROD || !isComparableVersion(APP_VERSION)) return null

  if (!forceRefresh) {
    const cache = readUpdateCache()
    if (cache && Date.now() - cache.fetchedAt < UPDATE_CACHE_TTL_MS) {
      if (!cache.latest) return null
      return isNewerVersion(cache.latest.latestVersion, APP_VERSION)
        ? {
            currentVersion: APP_VERSION,
            latestVersion: cache.latest.latestVersion,
            url: cache.latest.url,
          }
        : null
    }
  }

  let latest: UpdateInfo | null
  try {
    latest =
      (await fetchLatestRelease(signal).catch((err: unknown) => {
        if (signal?.aborted) throw err
        return null
      })) ??
      (await fetchLatestTag(signal).catch((err: unknown) => {
        if (signal?.aborted) throw err
        return null
      }))
  } catch (err) {
    if (signal?.aborted) throw err
    writeUpdateCache(null)
    return null
  }

  writeUpdateCache(latest ? { latestVersion: latest.latestVersion, url: latest.url } : null)

  if (!latest) return null
  return isNewerVersion(latest.latestVersion, latest.currentVersion) ? latest : null
}
