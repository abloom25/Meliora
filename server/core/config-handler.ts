import { isDevelopmentMode, type Env } from './types'
import { GitHubWriteError, readFile, writeFile, utf8ToBase64, type GitHubFile } from './github'
import { encryptString, decryptString, looksEncrypted } from './crypto'
import { validateMusicConfig } from '../../shared/config-schema'
import { defaultMusicConfig } from '../../shared/default-config'
import { logSanitizedError } from './error-handler'

const CONFIG_PATH = 'public/config.json'

const DEFAULT_CONFIG = JSON.stringify(defaultMusicConfig)

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
  const result = validateMusicConfig(body, { allowPrivateUrls: isDevelopmentMode(env) })
  if (!result.valid) {
    return new Response(JSON.stringify({ error: '配置校验失败', details: result.errors }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const content = JSON.stringify(result.config, null, 2)

  if (isDevelopmentMode(env)) {
    localConfigCache = content
    return new Response(JSON.stringify({ sha: 'local-dev', local: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const encrypted = await encryptString(content, env)
  let existing: GitHubFile | null
  try {
    existing = await readFile(CONFIG_PATH, env)
  } catch {
    return new Response(JSON.stringify({ error: '读取当前配置失败,请稍后重试' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const message = `chore(config): update config via admin ${new Date().toISOString()}`

  try {
    const sha = await writeFile(CONFIG_PATH, utf8ToBase64(encrypted), env, message, existing?.sha)
    return new Response(JSON.stringify({ sha }), {
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
