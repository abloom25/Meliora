export interface PublicEnvLike {
  GH_TOKEN?: string
  GH_REPO?: string
  CONFIG_ENCRYPTION_KEY?: string
  DEVELOPMENT?: string
}

export interface EnvValidation {
  ok: boolean
  errors: string[]
}

export interface KeyValidation {
  ok: boolean
  error?: string
}

const MIN_KEY_LENGTH = 32
const WEAK_KEY_PATTERNS = [
  /^(.)\1+$/,
  /^(0123456789|1234567890|abcdefgh|abcdefghijklmnopqrstuvwxyz)/i,
]

export function truthy(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'on'
}

export function isDevelopmentMode(env: PublicEnvLike): boolean {
  return truthy(env.DEVELOPMENT)
}

export function isValidGitHubRepo(value: string | undefined): boolean {
  const repo = value ?? ''
  if (!repo) return false
  if (repo !== repo.trim()) return false
  const parts = repo.split('/')
  if (parts.length !== 2) return false

  const [owner, name] = parts
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) return false
  if (name.length > 100) return false
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false
  if (name === '.' || name === '..' || name.endsWith('.git')) return false
  return true
}

export function isUsableGitHubToken(value: string | undefined): boolean {
  const token = value?.trim() || ''
  return Boolean(token && !token.toLowerCase().startsWith('placeholder'))
}

export function validateEncryptionKey(env: PublicEnvLike): KeyValidation {
  if (isDevelopmentMode(env)) return { ok: true }
  const key = env.CONFIG_ENCRYPTION_KEY || ''
  if (!key) {
    return {
      ok: false,
      error: '未设置 CONFIG_ENCRYPTION_KEY 环境变量,请在部署平台配置后再初始化',
    }
  }
  if (key.length < MIN_KEY_LENGTH) {
    return {
      ok: false,
      error: `CONFIG_ENCRYPTION_KEY 强度不足(至少 ${MIN_KEY_LENGTH} 位),请更换为足够长的随机字符串`,
    }
  }
  for (const pattern of WEAK_KEY_PATTERNS) {
    if (pattern.test(key)) {
      return {
        ok: false,
        error: 'CONFIG_ENCRYPTION_KEY 过于简单,请更换为随机字符串',
      }
    }
  }
  return { ok: true }
}

export function validatePublicEnv(env: PublicEnvLike): EnvValidation {
  if (isDevelopmentMode(env)) return { ok: true, errors: [] }

  const errors: string[] = []
  if (!isUsableGitHubToken(env.GH_TOKEN)) {
    errors.push('未设置可用 GH_TOKEN,请在部署平台配置 GitHub Token 后再初始化')
  }
  if (!isValidGitHubRepo(env.GH_REPO)) {
    errors.push('GH_REPO 格式无效,请使用 owner/repo 格式,例如 abloom25/Meliora')
  }

  const keyCheck = validateEncryptionKey(env)
  if (!keyCheck.ok && keyCheck.error) {
    errors.push(keyCheck.error)
  }

  return { ok: errors.length === 0, errors }
}
