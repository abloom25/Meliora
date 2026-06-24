import { isLocalMode, type Env } from './types'

const UPSTREAM_REPO = 'abloom25/Meliora'
const UPDATE_WORKFLOW = 'update-from-upstream.yml'
const GITHUB_API = 'https://api.github.com'

interface UpdateInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  releaseNotes: string
  releaseUrl: string
  publishedAt: string
}

interface GitHubRelease {
  tag_name: string
  body?: string
  html_url?: string
  published_at?: string
}

interface GitHubTag {
  name: string
  commit?: {
    sha?: string
  }
}

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

function normalizeVersion(version: string): string {
  return version
    .trim()
    .replace(/^refs\/tags\//, '')
    .replace(/^v/i, '')
}

function withGitHubProxy(targetUrl: string, env: Env, githubProxy?: string): string {
  const proxy = githubProxy?.trim() || env.GITHUB_PROXY?.trim()
  if (!proxy) return targetUrl
  if (proxy.includes('{url}')) return proxy.replace('{url}', encodeURIComponent(targetUrl))
  return `${proxy.replace(/\/+$/, '')}/${targetUrl}`
}

function shouldAttachGitHubToken(url: string): boolean {
  try {
    return new URL(url).origin === GITHUB_API
  } catch {
    return false
  }
}

function githubHeaders(env: Env, url: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Meliora-Admin',
  }
  if (env.GH_TOKEN && !env.GH_TOKEN.startsWith('placeholder') && shouldAttachGitHubToken(url)) {
    headers.Authorization = `Bearer ${env.GH_TOKEN}`
  }
  return headers
}

function githubUrl(path: string, env: Env, githubProxy?: string): string {
  return withGitHubProxy(`${GITHUB_API}${path}`, env, githubProxy)
}

function isStableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(normalizeVersion(version))
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

function compareVersionOrder(leftVersion: string, rightVersion: string): number {
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

function isNewerVersion(latestVersion: string, currentVersion: string): boolean {
  return compareVersionOrder(latestVersion, currentVersion) > 0
}

async function fetchLatestRelease(env: Env, githubProxy?: string): Promise<GitHubRelease | null> {
  const url = githubUrl(`/repos/${UPSTREAM_REPO}/releases/latest`, env, githubProxy)
  const response = await fetch(url, {
    headers: githubHeaders(env, url),
  })

  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`GitHub latest release failed: ${response.status}`)
  }

  return (await response.json()) as GitHubRelease
}

async function fetchLatestTag(env: Env, githubProxy?: string): Promise<GitHubTag | null> {
  const url = githubUrl(`/repos/${UPSTREAM_REPO}/tags`, env, githubProxy)
  const response = await fetch(url, {
    headers: githubHeaders(env, url),
  })

  if (!response.ok) {
    throw new Error(`GitHub tags failed: ${response.status}`)
  }

  const tags = (await response.json()) as GitHubTag[]
  return tags.find((tag) => isStableVersion(tag.name)) || tags[0] || null
}

export async function checkUpdate(
  currentVersion: string,
  env: Env,
  githubProxy?: string,
): Promise<Response> {
  const normalizedCurrentVersion = normalizeVersion(currentVersion)

  if (!normalizedCurrentVersion) {
    return new Response(JSON.stringify({ error: '缺少当前版本号' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const release = await fetchLatestRelease(env, githubProxy)
    const tag = release ? null : await fetchLatestTag(env, githubProxy)
    const latestTagName = release?.tag_name || tag?.name

    if (!latestTagName) {
      return new Response(JSON.stringify({ error: '无法获取版本信息' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const latestVersion = normalizeVersion(latestTagName)
    const hasUpdate = isNewerVersion(latestVersion, normalizedCurrentVersion)

    const info: UpdateInfo = {
      hasUpdate,
      currentVersion: normalizedCurrentVersion,
      latestVersion,
      releaseNotes: release?.body || '该版本暂无 Release 说明。',
      releaseUrl:
        release?.html_url || `https://github.com/${UPSTREAM_REPO}/releases/tag/${latestTagName}`,
      publishedAt: release?.published_at || '',
    }

    return new Response(JSON.stringify(info), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch {
    return new Response(JSON.stringify({ error: '网络错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

export async function triggerUpdate(env: Env, githubProxy?: string): Promise<Response> {
  if (isLocalMode(env)) {
    return new Response(JSON.stringify({ error: '本地开发模式不支持触发更新' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const url = githubUrl(
      `/repos/${env.GH_REPO}/actions/workflows/${UPDATE_WORKFLOW}/dispatches`,
      env,
      undefined,
    )
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...githubHeaders(env, url),
        // 注意:使用 GitHub 代理时,此 token 会随请求发送给代理服务器。
        // 代理是否可信由用户在前端自行确认(前端已对代理风险做出提示),
        // 此处按用户选择透传 token 以保证代理转发能通过 GitHub 鉴权。
        Authorization: `Bearer ${env.GH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: env.GH_BRANCH || 'main',
        inputs: {
          upstream_repo: UPSTREAM_REPO,
          github_proxy: githubProxy?.trim() || env.GITHUB_PROXY?.trim() || '',
        },
      }),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return new Response(JSON.stringify({ error: `触发失败: ${response.status}`, detail: text }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response(
      JSON.stringify({ success: true, message: '已触发更新流程,请稍后刷新查看' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  } catch {
    return new Response(JSON.stringify({ error: '网络错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
