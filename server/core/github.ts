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

function apiUrl(path: string, env: Env): string {
  const branch = env.GH_BRANCH || 'main'
  return `${GITHUB_API}/repos/${env.GH_REPO}/contents/${path}?ref=${branch}`
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

export async function readFile(path: string, env: Env): Promise<GitHubFile | null> {
  const response = await fetchWithTimeout(apiUrl(path, env), { headers: headers(env) })
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
// 调用方负责编码:文本类内容(加密后的配置/管理员数据)用 utf8ToBase64;
// 二进制类内容(音频/封面/歌词)由前端以 base64 形式传入,直接透传。
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

  const response = await fetchWithTimeout(apiUrl(path, env), {
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

export async function deleteFile(
  path: string,
  env: Env,
  message: string,
  sha: string,
): Promise<string> {
  const body = JSON.stringify({
    message,
    sha,
    branch: env.GH_BRANCH || 'main',
  })

  const response = await fetchWithTimeout(apiUrl(path, env), {
    method: 'DELETE',
    headers: { ...headers(env), 'Content-Type': 'application/json' },
    body,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`GitHub deleteFile failed: ${response.status} ${errorText}`)
  }

  const data = (await response.json()) as { commit?: { sha?: string } }
  return data.commit?.sha || ''
}
