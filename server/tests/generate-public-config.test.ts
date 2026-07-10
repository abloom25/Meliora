import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { encryptStoredConfig, generatePublicConfig } from '../../scripts/generate-public-config.mjs'

const STRONG_KEY = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6'
const WRONG_KEY = 'z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2h1g0f9e8d7c6b5a4'

const plaintextConfig = {
  siteName: 'Generated Meliora',
  apiEndpoint: 'https://api.example.com',
  apiToken: 'secret-token',
  githubProxy: 'https://github-proxy.example.com',
  playlists: [{ server: 'netease', playlistId: '123', enabled: true }],
  localTracks: [
    {
      id: 'local-1',
      title: 'Local Song',
      artist: 'Artist',
      audio: '/music/local-1.mp3',
    },
  ],
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'meliora-public-config-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function withTempCwd<T>(run: (dir: string) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const cwd = process.cwd()
    const envSnapshot = {
      GH_REPO: process.env.GH_REPO,
      CONFIG_ENCRYPTION_KEY: process.env.CONFIG_ENCRYPTION_KEY,
      DEVELOPMENT: process.env.DEVELOPMENT,
      ADMIN_DISABLED: process.env.ADMIN_DISABLED,
      MELIORA_LOAD_DEV_VARS: process.env.MELIORA_LOAD_DEV_VARS,
    }
    try {
      delete process.env.GH_REPO
      delete process.env.CONFIG_ENCRYPTION_KEY
      delete process.env.DEVELOPMENT
      delete process.env.ADMIN_DISABLED
      delete process.env.MELIORA_LOAD_DEV_VARS
      process.chdir(dir)
      return await run(dir)
    } finally {
      process.chdir(cwd)
      for (const [key, value] of Object.entries(envSnapshot)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
}

async function generateFromTemp(configContent: string | null, encryptionKey = '') {
  return withTempDir(async (dir) => {
    const configPath = join(dir, 'config.json')
    const targetPath = join(dir, 'public-config.ts')
    const adminEnvTargetPath = join(dir, 'admin-env.ts')
    if (configContent !== null) {
      await writeFile(configPath, configContent)
    }

    const result = await generatePublicConfig({
      configPath,
      targetPath,
      adminEnvTargetPath,
      encryptionKey,
      adminEnv: {
        DEVELOPMENT: 'true',
      },
    })
    const source = await readFile(targetPath, 'utf8')
    const adminEnvSource = await readFile(adminEnvTargetPath, 'utf8')
    return { result, source, adminEnvSource }
  })
}

describe('generate-public-config', () => {
  it('generates a default public config when public/config.json is missing', async () => {
    const { result, source } = await generateFromTemp(null)

    expect(result.config).toEqual({
      siteName: 'Meliora',
      apiEndpoint: '',
      playlists: [],
      localTracks: [],
    })
    expect(source).toContain("import type { PublicMusicConfig } from '../types/music'")
    expect(source).toContain('export const publicMusicConfig')
  })

  it('generates public config from plaintext public/config.json', async () => {
    const { result, source } = await generateFromTemp(JSON.stringify(plaintextConfig))

    expect(result.config.siteName).toBe('Generated Meliora')
    expect(result.config.playlists).toEqual(plaintextConfig.playlists)
    expect(result.config).not.toHaveProperty('apiToken')
    expect(result.config).not.toHaveProperty('githubProxy')
    expect(source).toContain("siteName: 'Generated Meliora'")
    expect(source).not.toContain('secret-token')
    expect(source).not.toContain('apiToken')
    expect(source).not.toContain('githubProxy')
  })

  it('generates public config from encrypted public/config.json', async () => {
    const encrypted = await encryptStoredConfig(JSON.stringify(plaintextConfig), STRONG_KEY)
    const { result, source } = await generateFromTemp(encrypted, STRONG_KEY)

    expect(result.config.siteName).toBe('Generated Meliora')
    expect(result.config.apiEndpoint).toBe('https://api.example.com')
    expect(result.config.localTracks).toEqual(plaintextConfig.localTracks)
    expect(result.config).not.toHaveProperty('apiToken')
    expect(result.config).not.toHaveProperty('githubProxy')
    expect(source).not.toContain('secret-token')
  })

  it('removes admin-only update preferences from generated public config', async () => {
    const config = {
      ...plaintextConfig,
      receivePrereleaseUpdates: true,
    }

    const { result, source } = await generateFromTemp(JSON.stringify(config))

    expect(result.config).not.toHaveProperty('receivePrereleaseUpdates')
    expect(source).not.toContain('receivePrereleaseUpdates')
  })

  it('fails clearly when encrypted public/config.json uses a different key', async () => {
    const encrypted = await encryptStoredConfig(JSON.stringify(plaintextConfig), STRONG_KEY)

    await expect(generateFromTemp(encrypted, WRONG_KEY)).rejects.toThrow(
      /Failed to decrypt public\/config\.json/,
    )
  })

  it('fails clearly when public/config.json does not match the music config schema', async () => {
    await expect(generateFromTemp(JSON.stringify({ siteName: '', playlists: [] }))).rejects.toThrow(
      /validation failed/,
    )
  })

  it('removes nested private fields before validating generated public config', async () => {
    const config = {
      ...plaintextConfig,
      analytics: {
        apiToken: 'nested-secret-token',
        githubProxy: 'https://nested-proxy.example.com',
        enabled: true,
      },
    }

    const { result, source } = await generateFromTemp(JSON.stringify(config))

    expect(result.config).not.toHaveProperty('apiToken')
    expect(result.config).not.toHaveProperty('analytics')
    expect(source).not.toContain('secret-token')
    expect(source).not.toContain('nested-secret-token')
    expect(source).not.toContain('apiToken')
    expect(source).not.toContain('githubProxy')
  })

  it('generates a disabled admin build status when ADMIN_DISABLED is truthy', async () => {
    await withTempDir(async (dir) => {
      const result = await generatePublicConfig({
        configPath: join(dir, 'missing-config.json'),
        targetPath: join(dir, 'public-config.ts'),
        adminEnvTargetPath: join(dir, 'admin-env.ts'),
        adminEnv: { ADMIN_DISABLED: 'true' },
      })
      const source = await readFile(result.adminEnvTargetPath, 'utf8')

      expect(source).toContain("status: 'disabled'")
      expect(source).toContain('管理后台已禁用')
    })
  })

  it('generates an env-not-ready admin build status from public env validation', async () => {
    await withTempDir(async (dir) => {
      const result = await generatePublicConfig({
        configPath: join(dir, 'missing-config.json'),
        targetPath: join(dir, 'public-config.ts'),
        adminEnvTargetPath: join(dir, 'admin-env.ts'),
        adminEnv: {
          GH_REPO: 'invalid',
          CONFIG_ENCRYPTION_KEY: '',
          DEVELOPMENT: '',
        },
      })
      const source = await readFile(result.adminEnvTargetPath, 'utf8')

      expect(source).toContain("status: 'env-not-ready'")
      expect(source).toContain('GH_TOKEN')
      expect(source).toContain('GH_REPO 格式无效')
      expect(source).toContain('CONFIG_ENCRYPTION_KEY')
    })
  })

  it('generates an idle admin build status in development mode', async () => {
    const { adminEnvSource } = await generateFromTemp(null)

    expect(adminEnvSource).toContain("status: 'idle'")
  })

  it('does not load .dev.vars during ordinary generation', async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, '.dev.vars'), 'DEVELOPMENT=true\n')
      const result = await generatePublicConfig({
        configPath: join(dir, 'missing-config.json'),
        targetPath: join(dir, 'public-config.ts'),
        adminEnvTargetPath: join(dir, 'admin-env.ts'),
      })
      const source = await readFile(result.adminEnvTargetPath, 'utf8')

      expect(source).toContain("status: 'env-not-ready'")
      expect(source).toContain('GH_TOKEN')
      expect(source).toContain('CONFIG_ENCRYPTION_KEY')
    })
  })

  it('loads .dev.vars only when explicitly requested for local development', async () => {
    await withTempCwd(async (dir) => {
      process.env.MELIORA_LOAD_DEV_VARS = 'true'
      await writeFile(join(dir, '.dev.vars'), 'DEVELOPMENT=true\n')
      const result = await generatePublicConfig({
        configPath: join(dir, 'missing-config.json'),
        targetPath: join(dir, 'public-config.ts'),
        adminEnvTargetPath: join(dir, 'admin-env.ts'),
      })
      const source = await readFile(result.adminEnvTargetPath, 'utf8')

      expect(source).toContain("status: 'idle'")
    })
  })

  it('prefers local development config when loading dev vars for local development', async () => {
    await withTempCwd(async (dir) => {
      process.env.MELIORA_LOAD_DEV_VARS = 'true'
      await writeFile(join(dir, '.dev.vars'), 'DEVELOPMENT=true\n')
      await mkdir(join(dir, '.meliora'), { recursive: true })
      await writeFile(
        join(dir, '.meliora/config.local.json'),
        JSON.stringify({
          siteName: 'Local Generated Meliora',
          apiEndpoint: '',
          playlists: [],
          localTracks: [
            { id: 'local', title: 'Local Song', artist: 'Artist', audio: '/music/local.mp3' },
          ],
        }),
      )

      const result = await generatePublicConfig({
        targetPath: join(dir, 'public-config.ts'),
        adminEnvTargetPath: join(dir, 'admin-env.ts'),
      })
      const source = await readFile(result.targetPath, 'utf8')

      expect(result.config.siteName).toBe('Local Generated Meliora')
      expect(source).toContain("siteName: 'Local Generated Meliora'")
    })
  })

  it('lets process.env override file-based build env values', async () => {
    await withTempCwd(async (dir) => {
      process.env.GH_REPO = 'owner/repo'
      process.env.GH_TOKEN = 'ghp_testtokenvalue1234567890abcdef'
      process.env.CONFIG_ENCRYPTION_KEY = STRONG_KEY
      await writeFile(
        join(dir, '.env'),
        'GH_REPO=invalid\nGH_TOKEN=placeholder\nCONFIG_ENCRYPTION_KEY=\n',
      )
      const result = await generatePublicConfig({
        configPath: join(dir, 'missing-config.json'),
        targetPath: join(dir, 'public-config.ts'),
        adminEnvTargetPath: join(dir, 'admin-env.ts'),
      })
      const source = await readFile(result.adminEnvTargetPath, 'utf8')

      expect(source).toContain("status: 'idle'")
    })
  })
})
