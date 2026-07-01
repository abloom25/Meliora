import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { webcrypto } from 'node:crypto'

const CIPHER_PREFIX = 'v1:'
const SALT_BYTES = 16
const IV_BYTES = 12
const PBKDF2_ITERATIONS = 100000

const DEFAULT_PUBLIC_CONFIG = {
  siteName: 'Meliora',
  apiEndpoint: '',
  playlists: [],
  localTracks: [],
}

const schemaSourcePath = join(process.cwd(), 'shared/config-schema.ts')
const envSchemaSourcePath = join(process.cwd(), 'shared/env-schema.ts')
const schemaBuildPath = join(
  process.cwd(),
  'node_modules/.tmp',
  `meliora-public-config-schema-${process.pid}.mjs`,
)
const envSchemaBuildPath = join(
  process.cwd(),
  'node_modules/.tmp',
  `meliora-public-env-schema-${process.pid}.mjs`,
)

let validateMusicConfigPromise
let envSchemaPromise

function parseEnvFile(content) {
  const env = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

function shouldLoadDevVars() {
  return process.argv.includes('--dev-vars') || truthy(process.env.MELIORA_LOAD_DEV_VARS)
}

async function loadBuildEnv() {
  const files = shouldLoadDevVars() ? ['.env', '.dev.vars'] : ['.env']
  const env = {}
  for (const file of files) {
    try {
      Object.assign(env, parseEnvFile(await readFile(join(process.cwd(), file), 'utf8')))
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
  }
  return { ...env, ...process.env }
}

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function truthy(value) {
  const v = String(value ?? '')
    .trim()
    .toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'on'
}

function resolveDefaultConfigPath() {
  return join(process.cwd(), 'public/config.json')
}

function resolveDefaultLocalDevConfigPath() {
  return join(process.cwd(), '.meliora/config.local.json')
}

function resolveDefaultTargetPath() {
  return join(process.cwd(), 'src/generated/public-config.ts')
}

function resolveDefaultAdminEnvTargetPath() {
  return join(process.cwd(), 'src/generated/admin-env.ts')
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function stripPrivateConfig(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stripPrivateConfig(item))
  }

  if (value && typeof value === 'object') {
    const cleaned = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === 'apiToken' || key === 'githubProxy' || key === 'receivePrereleaseUpdates') {
        continue
      }
      cleaned[key] = stripPrivateConfig(item)
    }
    return cleaned
  }

  return value
}

async function loadValidateMusicConfig() {
  if (!validateMusicConfigPromise) {
    validateMusicConfigPromise = (async () => {
      const ts = await import('typescript')
      const source = await readFile(schemaSourcePath, 'utf8')
      const transpiled = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ES2022,
          target: ts.ScriptTarget.ES2022,
          verbatimModuleSyntax: false,
        },
      }).outputText
      await mkdir(dirname(schemaBuildPath), { recursive: true })
      await writeFile(schemaBuildPath, transpiled)
      const moduleUrl = `${pathToFileURL(schemaBuildPath).href}?t=${Date.now()}`
      const schema = await import(moduleUrl)
      return schema.validateMusicConfig
    })()
  }
  return validateMusicConfigPromise
}

async function transpileSharedModule(sourcePath, buildPath) {
  const ts = await import('typescript')
  const source = await readFile(sourcePath, 'utf8')
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText
  await mkdir(dirname(buildPath), { recursive: true })
  await writeFile(buildPath, transpiled)
  return `${pathToFileURL(buildPath).href}?t=${Date.now()}`
}

async function loadEnvSchema() {
  if (!envSchemaPromise) {
    envSchemaPromise = (async () => {
      const moduleUrl = await transpileSharedModule(envSchemaSourcePath, envSchemaBuildPath)
      return import(moduleUrl)
    })()
  }
  return envSchemaPromise
}

async function toValidatedPublicConfig(config, sourceLabel) {
  const validateMusicConfig = await loadValidateMusicConfig()
  const publicInput = stripPrivateConfig(config)
  const result = validateMusicConfig(publicInput)
  if (!result.valid || !result.config) {
    throw new Error(
      `${sourceLabel} validation failed: ${result.errors.length ? result.errors.join('; ') : 'unknown error'}`,
    )
  }
  return result.config
}

function parseConfigJson(content, sourceLabel) {
  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config root must be an object')
    }
    return parsed
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse ${sourceLabel}: ${reason}`, { cause: error })
  }
}

async function deriveKey(salt, encryptionKey) {
  const encoder = new TextEncoder()
  const keyMaterial = await webcrypto.subtle.importKey(
    'raw',
    encoder.encode(encryptionKey),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return webcrypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptStoredConfig(plaintext, encryptionKey) {
  const salt = webcrypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKey(salt, encryptionKey)
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  )
  const ciphertextBytes = new Uint8Array(ciphertext)
  const combined = new Uint8Array(salt.length + iv.length + ciphertextBytes.length)
  combined.set(salt, 0)
  combined.set(iv, salt.length)
  combined.set(ciphertextBytes, salt.length + iv.length)
  return `${CIPHER_PREFIX}${Buffer.from(combined).toString('base64')}`
}

export async function decryptStoredConfig(stored, encryptionKey) {
  if (!stored.startsWith(CIPHER_PREFIX)) {
    throw new Error('Ciphertext version mismatch')
  }
  if (!encryptionKey) {
    throw new Error('CONFIG_ENCRYPTION_KEY is required to decrypt public/config.json')
  }

  try {
    const combined = Buffer.from(stored.slice(CIPHER_PREFIX.length), 'base64')
    if (combined.length <= SALT_BYTES + IV_BYTES) {
      throw new Error('ciphertext payload is too short')
    }

    const salt = combined.subarray(0, SALT_BYTES)
    const iv = combined.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES)
    const ciphertext = combined.subarray(SALT_BYTES + IV_BYTES)
    const key = await deriveKey(salt, encryptionKey)
    const plaintext = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    return new TextDecoder().decode(plaintext)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to decrypt public/config.json: ${reason}`, { cause: error })
  }
}

async function loadStoredConfig(configPath, encryptionKey) {
  let stored
  try {
    stored = await readFile(configPath, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return cloneJson(DEFAULT_PUBLIC_CONFIG)
    }
    throw error
  }

  const trimmed = stored.trim()
  if (!trimmed) return cloneJson(DEFAULT_PUBLIC_CONFIG)

  if (trimmed.startsWith(CIPHER_PREFIX)) {
    const plaintext = await decryptStoredConfig(trimmed, encryptionKey)
    return parseConfigJson(plaintext, configPath)
  }

  return parseConfigJson(trimmed, configPath)
}

async function renderPublicConfigModule(publicConfig) {
  const json = JSON.stringify(publicConfig, null, 2)
  const source = `import type { PublicMusicConfig } from '../types/music'\n\nexport const publicMusicConfig = ${json} satisfies PublicMusicConfig\n`
  const prettier = await import('prettier')
  const prettierOptions = (await prettier.resolveConfig(process.cwd())) ?? {}
  return prettier.format(source, {
    ...prettierOptions,
    parser: 'typescript',
    printWidth: 100,
    semi: false,
    singleQuote: true,
  })
}

async function renderAdminEnvModule(env) {
  const { validatePublicEnv } = await loadEnvSchema()
  let status = 'idle'
  let detail = ''
  if (truthy(env.ADMIN_DISABLED)) {
    status = 'disabled'
    detail = '管理后台已禁用'
  } else {
    const envCheck = validatePublicEnv(env)
    if (!envCheck.ok) {
      status = 'env-not-ready'
      detail = `环境变量未就绪:${envCheck.errors.join('; ')}`
    }
  }

  const source = `export type AdminBuildStatus = 'idle' | 'disabled' | 'env-not-ready'\n\nexport const adminBuildEnv: { status: AdminBuildStatus; detail: string } = ${JSON.stringify(
    { status, detail },
    null,
    2,
  )}\n`
  const prettier = await import('prettier')
  const prettierOptions = (await prettier.resolveConfig(process.cwd())) ?? {}
  return prettier.format(source, {
    ...prettierOptions,
    parser: 'typescript',
    printWidth: 100,
    semi: false,
    singleQuote: true,
  })
}

export async function generatePublicConfig(options = {}) {
  const buildEnv = { ...(await loadBuildEnv()), ...(options.adminEnv ?? {}) }
  const localDevConfigPath = resolveDefaultLocalDevConfigPath()
  const configPath =
    options.configPath ??
    (shouldLoadDevVars() && (await fileExists(localDevConfigPath))
      ? localDevConfigPath
      : resolveDefaultConfigPath())
  const targetPath = options.targetPath ?? resolveDefaultTargetPath()
  const adminEnvTargetPath = options.adminEnvTargetPath ?? resolveDefaultAdminEnvTargetPath()
  const encryptionKey = options.encryptionKey ?? buildEnv.CONFIG_ENCRYPTION_KEY ?? ''

  const config = await loadStoredConfig(configPath, encryptionKey)
  const publicConfig = await toValidatedPublicConfig(config, configPath)
  const moduleSource = await renderPublicConfigModule(publicConfig)

  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, moduleSource)
  await mkdir(dirname(adminEnvTargetPath), { recursive: true })
  await writeFile(adminEnvTargetPath, await renderAdminEnvModule(buildEnv))

  return { config: publicConfig, targetPath, adminEnvTargetPath }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) {
  await generatePublicConfig()
}
