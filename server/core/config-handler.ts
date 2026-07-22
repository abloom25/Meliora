import { isDevelopmentMode, type Env } from './types'
import {
  GitHubWriteError,
  readFile,
  utf8ToBase64,
  getBranchSnapshot,
  createBlob,
  listTreePaths,
  commitTreeAtomically,
  type GitHubBranchSnapshot,
  type GitHubFile,
  type GitHubTreeEntry,
} from './github'
import { encryptString, decryptString, looksEncrypted } from './crypto'
import { validateMusicConfig } from '../../shared/config-schema'
import { defaultMusicConfig } from '../../shared/default-config'
import { collectManagedAssetPaths } from '../../shared/managed-assets'
import { logSanitizedError } from './error-handler'
import { isAllowedUploadPath } from './upload-handler'
import type { MusicConfig } from '../../src/types/music'

const CONFIG_PATH = 'public/config.json'

const DEFAULT_CONFIG = JSON.stringify(defaultMusicConfig)
const MAX_STAGED_UPLOADS = 50

let localConfigCache: string | null = null

const CONFIG_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
}

export async function getConfig(env: Env): Promise<Response> {
  if (isDevelopmentMode(env)) {
    const content = localConfigCache || DEFAULT_CONFIG
    return new Response(content, {
      status: 200,
      headers: CONFIG_HEADERS,
    })
  }

  let file: GitHubFile | null
  try {
    file = await readFile(CONFIG_PATH, env)
  } catch (error) {
    logSanitizedError('getConfig readFile', error)
    return new Response(JSON.stringify({ error: '读取配置失败,请检查 GitHub 凭据或稍后重试' }), {
      status: 502,
      headers: CONFIG_HEADERS,
    })
  }
  if (!file) {
    return new Response(DEFAULT_CONFIG, {
      status: 200,
      headers: CONFIG_HEADERS,
    })
  }
  try {
    // 生产模式下仅接受密文;明文 JSON 视为损坏或未初始化,拒绝继续读取。
    if (looksEncrypted(file.content)) {
      const plaintext = await decryptString(file.content, env)
      return new Response(plaintext, {
        status: 200,
        headers: CONFIG_HEADERS,
      })
    }
    console.error('config.json is not encrypted')
    return new Response(JSON.stringify({ error: '配置文件不是有效密文,请重新保存配置' }), {
      status: 409,
      headers: CONFIG_HEADERS,
    })
  } catch (error) {
    logSanitizedError('config.json decryption', error)
    return new Response(
      JSON.stringify({ error: '配置文件解密失败,请检查 CONFIG_ENCRYPTION_KEY' }),
      {
        status: 409,
        headers: CONFIG_HEADERS,
      },
    )
  }
}

export async function putConfig(body: unknown, env: Env): Promise<Response> {
  const request = parseConfigWriteRequest(body)
  const result = validateMusicConfig(request.config, {
    allowPrivateUrls: isDevelopmentMode(env),
  })
  if (!result.valid) {
    return new Response(JSON.stringify({ error: '配置校验失败', details: result.errors }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const config = result.config!
  const stagedResult = validateStagedUploads(
    request.uploads,
    collectManagedAssetPaths(config),
    isDevelopmentMode(env),
  )
  if (!stagedResult.valid) {
    return new Response(
      JSON.stringify({ error: '暂存文件校验失败', details: stagedResult.errors }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }

  const content = JSON.stringify(config, null, 2)

  if (isDevelopmentMode(env)) {
    localConfigCache = content
    return new Response(JSON.stringify({ sha: 'local-dev', local: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let snapshot: GitHubBranchSnapshot
  let existing: GitHubFile | null
  try {
    snapshot = await getBranchSnapshot(env)
    existing = await readFile(CONFIG_PATH, env, snapshot.commitSha)
  } catch {
    return new Response(JSON.stringify({ error: '读取当前配置失败,请稍后重试' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const previousConfig = await readPreviousConfig(existing, env)
    if (!previousConfig) {
      return new Response(JSON.stringify({ error: '当前配置损坏或无法解密,请先恢复配置文件' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const previousPaths = collectManagedAssetPaths(previousConfig)
    const nextPaths = collectManagedAssetPaths(config)
    const deletionCandidates = [...previousPaths].filter((path) => !nextPaths.has(path))
    const deletionPaths = await existingPathsAtSnapshot(deletionCandidates, snapshot, env)

    const encrypted = await encryptString(content, env)
    const configBlobSha = await createBlob(utf8ToBase64(encrypted), env)
    const entries: GitHubTreeEntry[] = [
      { path: CONFIG_PATH, mode: '100644', type: 'blob', sha: configBlobSha },
      ...stagedResult.uploads.map(
        (upload): GitHubTreeEntry => ({
          path: upload.path,
          mode: '100644',
          type: 'blob',
          sha: upload.blobSha,
        }),
      ),
      ...deletionPaths.map(
        (path): GitHubTreeEntry => ({ path, mode: '100644', type: 'blob', sha: null }),
      ),
    ]
    const message = `chore(config): update config and assets via admin ${new Date().toISOString()}`
    const sha = await commitTreeAtomically(entries, env, message, snapshot)
    return new Response(JSON.stringify({ sha, committedUploads: stagedResult.uploads.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    // sha 乐观锁冲突:配置已被其他操作修改,提示用户刷新重试,而非直接 500。
    if (error instanceof GitHubWriteError && (error.status === 409 || error.status === 422)) {
      return new Response(JSON.stringify({ error: '配置已被其他操作修改,请刷新后重试' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw error
  }
}

interface StagedUploadInput {
  path?: unknown
  blobSha?: unknown
}

interface ConfigWriteRequest {
  config: unknown
  uploads: unknown
}

interface ValidatedStagedUpload {
  path: string
  blobSha: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseConfigWriteRequest(body: unknown): ConfigWriteRequest {
  if (isRecord(body) && Object.prototype.hasOwnProperty.call(body, 'config')) {
    return {
      config: body.config,
      uploads: body.uploads ?? [],
    }
  }
  // 兼容未更新的管理前端：旧请求体本身就是配置，且没有暂存文件。
  return { config: body, uploads: [] }
}

function validateStagedUploads(
  input: unknown,
  referencedPaths: Set<string>,
  development: boolean,
): { valid: boolean; uploads: ValidatedStagedUpload[]; errors: string[] } {
  const errors: string[] = []
  const uploads: ValidatedStagedUpload[] = []
  const paths = new Set<string>()

  if (!Array.isArray(input)) {
    return { valid: false, uploads, errors: ['uploads 必须是数组'] }
  }
  const inputs = input as StagedUploadInput[]

  if (inputs.length > MAX_STAGED_UPLOADS) {
    errors.push(`单次最多提交 ${MAX_STAGED_UPLOADS} 个暂存文件`)
  }

  for (const [index, input] of inputs.slice(0, MAX_STAGED_UPLOADS).entries()) {
    if (!isRecord(input) || typeof input.path !== 'string' || typeof input.blobSha !== 'string') {
      errors.push(`uploads[${index}] 格式无效`)
      continue
    }
    const pathCheck = isAllowedUploadPath(input.path)
    if (!pathCheck.allowed) {
      errors.push(`uploads[${index}].path 不在允许范围内`)
      continue
    }
    const path = pathCheck.normalizedPath
    if (paths.has(path)) {
      errors.push(`uploads[${index}].path 与已有暂存文件重复`)
      continue
    }
    if (!referencedPaths.has(path)) {
      errors.push(`uploads[${index}].path 未被当前配置引用`)
      continue
    }
    const blobSha = input.blobSha.trim()
    if ((!development && !/^[0-9a-f]{40,64}$/i.test(blobSha)) || (development && !blobSha)) {
      errors.push(`uploads[${index}].blobSha 无效`)
      continue
    }
    paths.add(path)
    uploads.push({ path, blobSha })
  }

  return { valid: errors.length === 0, uploads, errors }
}

async function readPreviousConfig(
  existing: GitHubFile | null,
  env: Env,
): Promise<MusicConfig | null> {
  if (!existing) return defaultMusicConfig
  if (!looksEncrypted(existing.content)) return null

  try {
    const plaintext = await decryptString(existing.content, env)
    const parsed = JSON.parse(plaintext) as unknown
    const validation = validateMusicConfig(parsed, { allowPrivateUrls: isDevelopmentMode(env) })
    return validation.valid ? validation.config! : null
  } catch (error) {
    logSanitizedError('putConfig previous config', error)
    return null
  }
}

async function existingPathsAtSnapshot(
  candidates: string[],
  snapshot: GitHubBranchSnapshot,
  env: Env,
): Promise<string[]> {
  if (candidates.length === 0) return []

  const listing = await listTreePaths(snapshot.treeSha, env)
  const present = candidates.filter((path) => listing.paths.has(path))
  if (!listing.truncated) return present

  // GitHub 对超大仓库可能截断 recursive tree；对未出现在截断结果中的候选项逐个确认，
  // 既不漏删真实旧文件，也避免向 Tree API 提交“删除不存在路径”的无效条目。
  const uncertain = candidates.filter((path) => !listing.paths.has(path))
  const checked = await Promise.all(
    uncertain.map(async (path) => ({
      path,
      exists: Boolean(await readFile(path, env, snapshot.commitSha)),
    })),
  )
  return [...present, ...checked.filter((item) => item.exists).map((item) => item.path)]
}
