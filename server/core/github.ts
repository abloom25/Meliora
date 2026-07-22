import type { Env } from './types'

const GITHUB_API = 'https://api.github.com'
const GITHUB_TIMEOUT_MS = 8000

export class GitHubWriteError extends Error {
  readonly status: number
  readonly detail: string

  constructor(message: string, status: number, detail: string) {
    super(message)
    this.name = 'GitHubWriteError'
    this.status = status
    this.detail = detail
  }
}

// GitHub 读取故障(非 404):网络超时、5xx、JSON 解析失败等。
// 与"文件不存在"(返回 null)区分,避免调用方把 API 故障误判为文件缺失,
// 进而导致 isInitialized 误报未初始化、/setup 误开放等安全后果。
export class GitHubReadError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'GitHubReadError'
    this.status = status
  }
}

// 对 GitHub Contents API 路径做分段编码:按 / 拆分后对每段 encodeURIComponent,
// 既编码段内的 ?/#/&/空格 等特殊字符(避免扭曲 URL 或注入查询参数),
// 又保留 / 作为路径分隔符。GH_REPO(owner/repo)同样按 owner 与 repo 两段编码,
// 防止仓库标识中的特殊字符破坏 URL。
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function contentsApiUrl(path: string, env: Env, ref = env.GH_BRANCH || 'main'): string {
  const branch = encodeURIComponent(ref)
  const repo = encodePath(env.GH_REPO)
  return `${GITHUB_API}/repos/${repo}/contents/${encodePath(path)}?ref=${branch}`
}

function repositoryApiUrl(resource: string, env: Env): string {
  const repo = encodePath(env.GH_REPO)
  return `${GITHUB_API}/repos/${repo}/${resource}`
}

function headers(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = GITHUB_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export interface GitHubFile {
  content: string
  sha: string
}

export async function readFile(
  path: string,
  env: Env,
  ref = env.GH_BRANCH || 'main',
): Promise<GitHubFile | null> {
  const response = await fetchWithTimeout(contentsApiUrl(path, env, ref), {
    headers: headers(env),
  })
  // 404 表示文件不存在,返回 null 让调用方按"未初始化/未创建"处理。
  if (response.status === 404) return null
  if (!response.ok)
    throw new GitHubReadError(`GitHub readFile failed: ${response.status}`, response.status)

  const data = (await response.json()) as { content?: string; sha?: string; encoding?: string }
  if (!data.content || !data.sha) return null

  const content = data.encoding === 'base64' ? atob(data.content.replace(/\n/g, '')) : data.content

  return { content, sha: data.sha }
}

// UTF-8 安全的 base64 编码:裸 btoa 遇到非 ASCII 字符会抛 InvalidCharacterError,
// 先用 TextEncoder 转 UTF-8 字节再逐字节拼接,保证任意字符串可编码。
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

// contentBase64 必须是已 base64 编码的内容(GitHub Contents API 要求)。
// 调用方负责编码:文本类内容(管理员数据等)用 utf8ToBase64。
// 媒体文件使用 createBlob 暂存，并通过 commitTreeAtomically 与配置一起提交。
// 严禁在此处再次编码,否则会导致生产环境文件内容双重编码而损坏。
export async function writeFile(
  path: string,
  contentBase64: string,
  env: Env,
  message: string,
  sha?: string | null,
): Promise<string> {
  const body: Record<string, unknown> = {
    message,
    content: contentBase64,
    branch: env.GH_BRANCH || 'main',
  }
  if (sha) body.sha = sha

  const response = await fetchWithTimeout(contentsApiUrl(path, env), {
    method: 'PUT',
    headers: { ...headers(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new GitHubWriteError(
      `GitHub writeFile failed: ${response.status} ${errorText}`,
      response.status,
      errorText,
    )
  }

  const data = (await response.json()) as { commit?: { sha?: string } }
  return data.commit?.sha || ''
}

export interface GitHubBranchSnapshot {
  commitSha: string
  treeSha: string
}

export interface GitHubTreeEntry {
  path: string
  mode: '100644'
  type: 'blob'
  sha: string | null
}

export interface GitHubTreeListing {
  paths: Set<string>
  truncated: boolean
}

async function readRequiredJson<T>(url: string, env: Env, operation: string): Promise<T> {
  const response = await fetchWithTimeout(url, { headers: headers(env) })
  if (!response.ok) {
    throw new GitHubReadError(`GitHub ${operation} failed: ${response.status}`, response.status)
  }
  return (await response.json()) as T
}

async function writeJson<T>(
  url: string,
  env: Env,
  operation: string,
  method: 'POST' | 'PATCH',
  body: unknown,
): Promise<T> {
  const response = await fetchWithTimeout(url, {
    method,
    headers: { ...headers(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new GitHubWriteError(
      `GitHub ${operation} failed: ${response.status} ${detail}`,
      response.status,
      detail,
    )
  }
  return (await response.json()) as T
}

/** 获取分支头及其根 Tree，后续所有读取和提交都固定在这份快照上。 */
export async function getBranchSnapshot(env: Env): Promise<GitHubBranchSnapshot> {
  const branch = env.GH_BRANCH || 'main'
  const ref = await readRequiredJson<{ object?: { sha?: string } }>(
    repositoryApiUrl(`git/ref/heads/${encodePath(branch)}`, env),
    env,
    'getBranchRef',
  )
  const commitSha = ref.object?.sha
  if (!commitSha) throw new GitHubReadError('GitHub branch ref has no commit SHA', 502)

  const commit = await readRequiredJson<{ tree?: { sha?: string } }>(
    repositoryApiUrl(`git/commits/${encodeURIComponent(commitSha)}`, env),
    env,
    'getCommit',
  )
  const treeSha = commit.tree?.sha
  if (!treeSha) throw new GitHubReadError('GitHub commit has no tree SHA', 502)
  return { commitSha, treeSha }
}

/**
 * 创建尚未挂载到任何分支的 Git Blob。只有后续原子配置提交成功后，文件才会在线上出现。
 */
export async function createBlob(contentBase64: string, env: Env): Promise<string> {
  const result = await writeJson<{ sha?: string }>(
    repositoryApiUrl('git/blobs', env),
    env,
    'createBlob',
    'POST',
    { content: contentBase64, encoding: 'base64' },
  )
  if (!result.sha) throw new GitHubWriteError('GitHub createBlob returned no SHA', 502, '')
  return result.sha
}

/** 列出快照 Tree 中的文件路径，用于避免删除本来就不存在的条目。 */
export async function listTreePaths(treeSha: string, env: Env): Promise<GitHubTreeListing> {
  const result = await readRequiredJson<{
    tree?: Array<{ path?: string; type?: string }>
    truncated?: boolean
  }>(repositoryApiUrl(`git/trees/${encodeURIComponent(treeSha)}?recursive=1`, env), env, 'listTree')
  const paths = new Set(
    (result.tree || [])
      .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
      .map((entry) => entry.path as string),
  )
  return { paths, truncated: result.truncated === true }
}

/**
 * 基于指定快照创建一个 Commit，并以非 force 方式推进分支。
 * 如果分支在此期间被其他写入推进，GitHub 会拒绝非快进更新，从而保持原提交不变。
 */
export async function commitTreeAtomically(
  entries: GitHubTreeEntry[],
  env: Env,
  message: string,
  snapshot: GitHubBranchSnapshot,
): Promise<string> {
  const tree = await writeJson<{ sha?: string }>(
    repositoryApiUrl('git/trees', env),
    env,
    'createTree',
    'POST',
    { base_tree: snapshot.treeSha, tree: entries },
  )
  if (!tree.sha) throw new GitHubWriteError('GitHub createTree returned no SHA', 502, '')

  const commit = await writeJson<{ sha?: string }>(
    repositoryApiUrl('git/commits', env),
    env,
    'createCommit',
    'POST',
    { message, tree: tree.sha, parents: [snapshot.commitSha] },
  )
  if (!commit.sha) throw new GitHubWriteError('GitHub createCommit returned no SHA', 502, '')

  const branch = env.GH_BRANCH || 'main'
  await writeJson(
    repositoryApiUrl(`git/refs/heads/${encodePath(branch)}`, env),
    env,
    'updateBranchRef',
    'PATCH',
    { sha: commit.sha, force: false },
  )
  return commit.sha
}
