import {
  isPrereleaseVersion,
  isSemver,
  normalizeVersionTag,
  selectLatestVersion,
  shouldOfferUpdate,
} from '../../shared/version'
import { isDevelopmentMode, isPublicHttpUrl, type Env } from './types'

const UPSTREAM_REPO = 'abloom25/Meliora'
const UPDATE_WORKFLOW = 'update-from-upstream.yml'
const GITHUB_API = 'https://api.github.com'
const UPDATE_FETCH_TIMEOUT_MS = 8000
const UPDATE_STATUS_CACHE_TTL_MS = 3000

interface UpdateInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  targetTag: string
  releaseNotes: string
  releaseUrl: string
  publishedAt: string
}

interface GitHubRelease {
  tag_name?: string
  body?: string
  html_url?: string
  published_at?: string
}

interface GitHubTag {
  name?: string
}

interface GitHubWorkflowRun {
  id?: number
  run_number?: number
  run_attempt?: number
  event?: string
  head_branch?: string
  status?: string
  conclusion?: string | null
  created_at?: string
  updated_at?: string
  run_started_at?: string
  html_url?: string
  head_sha?: string
  display_title?: string
  head_commit?: {
    url?: string
  }
}

interface GitHubRequestError extends Error {
  status?: number
}

interface UpdateStatusCacheEntry {
  key: string
  expiresAt: number
  response: Response
}

let updateStatusCache: UpdateStatusCacheEntry | null = null

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function createGitHubError(message: string, status?: number): GitHubRequestError {
  const error = new Error(message) as GitHubRequestError
  error.status = status
  return error
}

function validateGitHubProxy(
  proxy: string | undefined,
): { ok: true; value?: string } | { ok: false } {
  const trimmed = proxy?.trim()
  if (!trimmed) return { ok: true }
  const probe = trimmed.includes('{url}')
    ? trimmed.replace('{url}', encodeURIComponent(GITHUB_API))
    : trimmed
  return isPublicHttpUrl(probe) ? { ok: true, value: trimmed } : { ok: false }
}

// githubProxy 只用于管理员明确配置的可信代理场景。检查更新经代理请求时不附带 GH_TOKEN；
// 触发 workflow dispatch 固定直连 GitHub API,代理只作为 workflow input 传给后续上游拉取步骤。
function withGitHubProxy(targetUrl: string, proxy?: string): string {
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

function githubUrl(path: string, proxy?: string): string {
  return withGitHubProxy(`${GITHUB_API}${path}`, proxy)
}

function repoApiUrl(env: Env, path: string): string {
  return `${GITHUB_API}/repos/${env.GH_REPO}${path}`
}

async function fetchLatestRelease(
  env: Env,
  proxy: string | undefined,
  signal: AbortSignal,
): Promise<GitHubRelease | null> {
  const url = githubUrl(`/repos/${UPSTREAM_REPO}/releases/latest`, proxy)
  const response = await fetch(url, {
    headers: githubHeaders(env, url),
    signal,
  })

  if (response.status === 404) return null
  if (!response.ok) {
    throw createGitHubError(`GitHub latest release failed: ${response.status}`, response.status)
  }

  return (await response.json()) as GitHubRelease
}

async function fetchLatestTag(
  env: Env,
  proxy: string | undefined,
  signal: AbortSignal,
  includePrerelease: boolean,
): Promise<GitHubTag | null> {
  const url = githubUrl(`/repos/${UPSTREAM_REPO}/tags?per_page=100`, proxy)
  const response = await fetch(url, {
    headers: githubHeaders(env, url),
    signal,
  })

  if (!response.ok) {
    throw createGitHubError(`GitHub tags failed: ${response.status}`, response.status)
  }

  const tags = (await response.json()) as GitHubTag[]
  return selectLatestVersion(tags, (tag) => tag.name, { includePrerelease })
}

function createTimeoutSignal(): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPDATE_FETCH_TIMEOUT_MS)
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function mapGitHubError(error: unknown): { error: string; status: number } {
  if (isAbortError(error)) return { error: '检查更新超时,请稍后重试', status: 504 }

  const status = (error as GitHubRequestError).status ?? 0
  if (status === 401 || status === 403) {
    return { error: 'GitHub 鉴权失败或速率受限,请检查 GH_TOKEN 权限', status: 502 }
  }
  if (status === 429) return { error: 'GitHub 请求过于频繁,请稍后再试', status: 429 }
  if (status >= 500) return { error: 'GitHub 服务暂时不可用', status: 502 }
  return { error: '网络错误', status: 500 }
}

function releaseMatchesTag(release: GitHubRelease | null, tagName: string): boolean {
  return normalizeVersionTag(release?.tag_name || '') === normalizeVersionTag(tagName)
}

function getGitHubVersion(item: GitHubRelease | GitHubTag): string | undefined {
  if ('tag_name' in item) return item.tag_name
  if ('name' in item) return item.name
  return undefined
}

function isGitHubRelease(item: GitHubRelease | GitHubTag | null): item is GitHubRelease {
  return Boolean(item && 'tag_name' in item)
}

export async function checkUpdate(
  currentVersion: string,
  env: Env,
  githubProxy?: string,
  receivePrereleaseUpdates = false,
): Promise<Response> {
  const normalizedCurrentVersion = normalizeVersionTag(currentVersion)

  if (!normalizedCurrentVersion || !isSemver(normalizedCurrentVersion)) {
    return jsonResponse({ error: '当前版本号无效' }, 400)
  }

  const proxyCheck = validateGitHubProxy(githubProxy || env.GITHUB_PROXY)
  if (!proxyCheck.ok) {
    return jsonResponse({ error: 'GitHub 代理必须是公网 http(s) URL' }, 400)
  }

  const includePrerelease =
    receivePrereleaseUpdates || isPrereleaseVersion(normalizedCurrentVersion)
  const { signal, cleanup } = createTimeoutSignal()

  try {
    const release = await fetchLatestRelease(env, proxyCheck.value, signal)
    const tag = await fetchLatestTag(env, proxyCheck.value, signal, includePrerelease).catch(
      (error: unknown) => {
        if (release) return null
        throw error
      },
    )
    const candidates = [release, tag].filter((item): item is GitHubRelease | GitHubTag =>
      Boolean(item),
    )
    const latest = selectLatestVersion(candidates, getGitHubVersion, {
      includePrerelease,
    })
    const latestTagName = latest ? getGitHubVersion(latest) : undefined

    if (!latestTagName) {
      return jsonResponse({ error: '无法获取有效版本信息' }, 502)
    }

    const latestVersion = normalizeVersionTag(latestTagName)
    const hasUpdate = shouldOfferUpdate(latestVersion, normalizedCurrentVersion, {
      includePrerelease,
    })
    const releaseForNotes = isGitHubRelease(latest)
      ? latest
      : releaseMatchesTag(release, latestTagName)
        ? release
        : null

    const info: UpdateInfo = {
      hasUpdate,
      currentVersion: normalizedCurrentVersion,
      latestVersion,
      targetTag: latestTagName,
      releaseNotes: releaseForNotes?.body || '该版本暂无 Release 说明。',
      releaseUrl:
        releaseForNotes?.html_url ||
        `https://github.com/${UPSTREAM_REPO}/releases/tag/${latestTagName}`,
      publishedAt: releaseForNotes?.published_at || '',
    }

    return jsonResponse(info, 200)
  } catch (error) {
    const mapped = mapGitHubError(error)
    return jsonResponse({ error: mapped.error }, mapped.status)
  } finally {
    cleanup()
  }
}

function normalizeRunStatus(run: GitHubWorkflowRun): string {
  if (run.status !== 'completed') {
    if (run.status === 'queued' || run.status === 'waiting' || run.status === 'pending') {
      return 'queued'
    }
    if (run.status === 'in_progress' || run.status === 'requested') return 'running'
    return 'unknown'
  }

  if (run.conclusion === 'success') return 'success'
  if (run.conclusion === 'cancelled') return 'cancelled'
  if (run.conclusion === 'timed_out') return 'timed_out'
  return 'failed'
}

function statusMessage(displayStatus: string): string {
  if (displayStatus === 'locating') return '已触发更新,正在等待 GitHub Actions 创建运行记录'
  if (displayStatus === 'queued') return '更新任务已排队,等待 GitHub Actions 执行'
  if (displayStatus === 'running') return '更新任务运行中,完成后会自动同步到当前分支'
  if (displayStatus === 'success') return '更新完成,已自动同步并推送到当前分支'
  if (displayStatus === 'cancelled') return '更新任务已取消'
  if (displayStatus === 'timed_out') return '更新任务超时'
  if (displayStatus === 'failed') return '更新失败,目标分支未写入更新'
  return '无法确认更新状态'
}

function retryAfterSeconds(displayStatus: string): number | undefined {
  if (displayStatus === 'locating' || displayStatus === 'queued') return 3
  if (displayStatus === 'running') return 5
  return undefined
}

function failureMessage(displayStatus: string, conclusion: string | null | undefined): string {
  if (displayStatus === 'failed') {
    return '更新验证、合并或推送失败,目标分支未写入更新。请打开 GitHub Actions 查看详细日志。'
  }
  if (displayStatus === 'cancelled') return '更新任务已取消,目标分支未写入更新。'
  if (displayStatus === 'timed_out') return '更新任务超时,目标分支未写入更新。'
  return conclusion ? `更新任务结束状态: ${conclusion}` : '更新状态未知。'
}

function toRunPayload(run: GitHubWorkflowRun, env: Env) {
  const displayStatus = normalizeRunStatus(run)
  const latestCommitSha = run.head_sha || ''
  return {
    id: run.id || 0,
    runNumber: run.run_number || 0,
    runAttempt: run.run_attempt || 0,
    event: run.event || '',
    branch: run.head_branch || '',
    status: run.status || '',
    conclusion: run.conclusion ?? null,
    displayStatus,
    createdAt: run.created_at || '',
    updatedAt: run.updated_at || '',
    startedAt: run.run_started_at || '',
    htmlUrl: run.html_url || '',
    latestCommitSha,
    latestCommitUrl: latestCommitSha
      ? `https://github.com/${env.GH_REPO}/commit/${latestCommitSha}`
      : '',
  }
}

function parseSince(value: string | null): Date {
  if (!value) return new Date(Date.now() - 10 * 60 * 1000)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return new Date(Date.now() - 10 * 60 * 1000)
  return parsed
}

async function fetchWorkflowRuns(env: Env, signal: AbortSignal): Promise<GitHubWorkflowRun[]> {
  const branch = encodeURIComponent(env.GH_BRANCH || 'main')
  const url = repoApiUrl(
    env,
    `/actions/workflows/${UPDATE_WORKFLOW}/runs?event=workflow_dispatch&branch=${branch}&per_page=5`,
  )
  const response = await fetch(url, {
    headers: githubHeaders(env, url),
    signal,
  })

  if (!response.ok) {
    throw createGitHubError(`GitHub workflow runs failed: ${response.status}`, response.status)
  }

  const data = (await response.json()) as { workflow_runs?: GitHubWorkflowRun[] }
  return Array.isArray(data.workflow_runs) ? data.workflow_runs : []
}

export async function getUpdateStatus(
  env: Env,
  sinceValue: string | null,
  triggerId?: string,
): Promise<Response> {
  if (!hasUsableGitHubToken(env)) {
    return jsonResponse(
      {
        error:
          '未配置可用 GH_TOKEN。Fine-grained token 需要 Contents: read/write 与 Actions: write 权限; classic token 可使用 repo 权限。',
      },
      400,
    )
  }

  const normalizedTriggerId = triggerId?.trim() || ''
  const cacheKey = `${env.GH_REPO}:${env.GH_BRANCH || 'main'}:${sinceValue || ''}:${normalizedTriggerId}`
  if (updateStatusCache?.key === cacheKey && Date.now() < updateStatusCache.expiresAt) {
    return updateStatusCache.response.clone()
  }

  const since = parseSince(sinceValue)
  const threshold = since.getTime() - 10_000
  const { signal, cleanup } = createTimeoutSignal()
  try {
    const runs = await fetchWorkflowRuns(env, signal)
    const run =
      runs
        .filter((item) => {
          const createdAt = item.created_at ? new Date(item.created_at).getTime() : 0
          if (createdAt < threshold) return false
          if (!normalizedTriggerId) return true
          return (item.display_title || '').includes(normalizedTriggerId)
        })
        .sort((left, right) => {
          const leftTime = left.created_at ? new Date(left.created_at).getTime() : 0
          const rightTime = right.created_at ? new Date(right.created_at).getTime() : 0
          return rightTime - leftTime
        })[0] || null

    if (!run) {
      const response = jsonResponse(
        {
          ok: true,
          run: null,
          message: statusMessage('locating'),
          retryAfterSeconds: retryAfterSeconds('locating'),
        },
        200,
      )
      updateStatusCache = {
        key: cacheKey,
        expiresAt: Date.now() + UPDATE_STATUS_CACHE_TTL_MS,
        response: response.clone(),
      }
      return response
    }

    const runPayload = toRunPayload(run, env)
    const failure =
      runPayload.displayStatus === 'failed' ||
      runPayload.displayStatus === 'cancelled' ||
      runPayload.displayStatus === 'timed_out'
        ? {
            message: failureMessage(runPayload.displayStatus, run.conclusion),
            conclusion: run.conclusion || '',
          }
        : undefined
    const response = jsonResponse(
      {
        ok: true,
        run: runPayload,
        failure,
        message: statusMessage(runPayload.displayStatus),
        retryAfterSeconds: retryAfterSeconds(runPayload.displayStatus),
      },
      200,
    )
    updateStatusCache = {
      key: cacheKey,
      expiresAt: Date.now() + UPDATE_STATUS_CACHE_TTL_MS,
      response: response.clone(),
    }
    return response
  } catch (error) {
    const mapped = mapGitHubError(error)
    return jsonResponse({ ok: false, error: mapped.error, message: mapped.error }, mapped.status)
  } finally {
    cleanup()
  }
}

function hasUsableGitHubToken(env: Env): boolean {
  const token = env.GH_TOKEN?.trim()
  return Boolean(token && !token.toLowerCase().startsWith('placeholder'))
}

export async function triggerUpdate(
  env: Env,
  githubProxy?: string,
  targetTag?: string,
  allowPrerelease = false,
): Promise<Response> {
  if (isDevelopmentMode(env)) {
    return jsonResponse({ error: '本地开发模式不支持触发更新' }, 400)
  }

  if (!hasUsableGitHubToken(env)) {
    return jsonResponse(
      {
        error:
          '未配置可用 GH_TOKEN。Fine-grained token 需要 Contents: read/write 与 Actions: write 权限; classic token 可使用 repo 权限。',
      },
      400,
    )
  }

  const proxyCheck = validateGitHubProxy(githubProxy || env.GITHUB_PROXY)
  if (!proxyCheck.ok) {
    return jsonResponse({ error: 'GitHub 代理必须是公网 http(s) URL' }, 400)
  }
  const normalizedTargetTag = targetTag?.trim() || ''
  if (normalizedTargetTag && !isSemver(normalizedTargetTag)) {
    return jsonResponse({ error: '目标版本号无效' }, 400)
  }

  try {
    const triggeredAt = new Date().toISOString()
    const triggerId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const url = `${GITHUB_API}/repos/${env.GH_REPO}/actions/workflows/${UPDATE_WORKFLOW}/dispatches`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...githubHeaders(env, url),
        Authorization: `Bearer ${env.GH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: env.GH_BRANCH || 'main',
        inputs: {
          upstream_repo: UPSTREAM_REPO,
          github_proxy: proxyCheck.value || '',
          target_tag: normalizedTargetTag,
          allow_prerelease: allowPrerelease ? 'true' : 'false',
          trigger_id: triggerId,
        },
      }),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return jsonResponse({ error: `触发失败: ${response.status}`, detail: text }, 502)
    }

    return jsonResponse(
      {
        success: true,
        message: '已触发更新流程,正在等待执行状态',
        triggeredAt,
        triggerId,
      },
      200,
    )
  } catch {
    return jsonResponse({ error: '网络错误' }, 500)
  }
}
