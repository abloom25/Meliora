import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadFile, deleteTrackFiles } from '../core/upload-handler'
import type { Env } from '../core/types'

const ENV: Env = {
  GH_TOKEN: 'placeholder',
  GH_REPO: 'owner/repo',
  GH_BRANCH: 'main',
  CONFIG_ENCRYPTION_KEY: '',
  DEVELOPMENT: 'true',
}

const REMOTE_ENV: Env = {
  ...ENV,
  DEVELOPMENT: 'false',
}

describe('upload-handler path whitelist', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('uploadFile', () => {
    it('rejects missing path', async () => {
      const response = await uploadFile({ path: '', content: 'data' }, ENV)
      expect(response.status).toBe(400)
      const data = (await response.json()) as { error: string }
      expect(data.error).toContain('path')
    })

    it('rejects missing content', async () => {
      const response = await uploadFile({ path: 'public/music/test.mp3', content: '' }, ENV)
      expect(response.status).toBe(400)
      const data = (await response.json()) as { error: string }
      expect(data.error).toContain('content')
    })

    it('allows music asset paths under public/music/', async () => {
      const response = await uploadFile(
        { path: 'public/music/sample/audio.flac', content: 'data' },
        ENV,
      )
      expect(response.status).toBe(200)
    })

    it('allows paths with leading ./ under public/', async () => {
      const response = await uploadFile({ path: './public/music/test.mp3', content: 'data' }, ENV)
      expect(response.status).toBe(200)
    })

    it('allows paths with leading slash under public/', async () => {
      const response = await uploadFile({ path: '/public/music/test.mp3', content: 'data' }, ENV)
      expect(response.status).toBe(200)
    })

    it('allows raster site icon uploads at the dedicated public icon path', async () => {
      const response = await uploadFile({ path: 'public/icon.webp', content: 'data' }, ENV)
      expect(response.status).toBe(200)
    })

    it('rejects public paths outside the music and icon upload allowlist', async () => {
      const response = await uploadFile({ path: 'public/random.txt', content: 'data' }, ENV)
      expect(response.status).toBe(400)
    })

    it('rejects service worker overwrite attempts', async () => {
      const response = await uploadFile({ path: 'public/sw.js', content: 'malicious' }, ENV)
      expect(response.status).toBe(400)
    })

    it('rejects manifest overwrite attempts', async () => {
      const response = await uploadFile(
        { path: 'public/manifest.webmanifest', content: 'malicious' },
        ENV,
      )
      expect(response.status).toBe(400)
    })

    it('rejects robots.txt overwrite attempts', async () => {
      const response = await uploadFile({ path: 'public/robots.txt', content: 'malicious' }, ENV)
      expect(response.status).toBe(400)
    })

    it('rejects executable frontend file extensions even under public/music/', async () => {
      const paths = [
        'public/music/track/player.js',
        'public/music/track/index.html',
        'public/music/track/theme.css',
      ]

      for (const path of paths) {
        const response = await uploadFile({ path, content: 'malicious' }, ENV)
        expect(response.status).toBe(400)
      }
    })

    it('rejects svg uploads for site icons', async () => {
      const response = await uploadFile({ path: 'public/icon.svg', content: 'data' }, ENV)
      expect(response.status).toBe(400)
    })

    it('rejects absolute URL-looking paths', async () => {
      const response = await uploadFile(
        { path: 'https://evil.example/public/music/test.mp3', content: 'data' },
        ENV,
      )
      expect(response.status).toBe(400)
    })

    it('rejects server config paths', async () => {
      const response = await uploadFile(
        { path: 'server/core/router.ts', content: 'malicious' },
        ENV,
      )
      expect(response.status).toBe(400)
      const data = (await response.json()) as { error: string }
      expect(data.error).toContain('路径不在允许范围内')
    })

    it('rejects public/config.json (protected config storage path)', async () => {
      const response = await uploadFile({ path: 'public/config.json', content: 'data' }, ENV)
      expect(response.status).toBe(400)
      const data = (await response.json()) as { error: string }
      expect(data.error).toContain('路径不在允许范围内')
    })

    it('rejects public/admin.json (protected admin data path)', async () => {
      const response = await uploadFile({ path: 'public/admin.json', content: 'data' }, ENV)
      expect(response.status).toBe(400)
      const data = (await response.json()) as { error: string }
      expect(data.error).toContain('路径不在允许范围内')
    })

    it('rejects path traversal attempts', async () => {
      const response = await uploadFile(
        { path: 'public/../server/core/router.ts', content: 'malicious' },
        ENV,
      )
      expect(response.status).toBe(400)
    })

    it('rejects encoded path traversal attempts', async () => {
      const response = await uploadFile(
        { path: 'public/%2e%2e/server/core/router.ts', content: 'malicious' },
        ENV,
      )
      expect(response.status).toBe(400)
    })

    it('rejects malformed percent-encoded paths', async () => {
      const response = await uploadFile({ path: 'public/music/%E0%A4%A.mp3', content: 'data' }, ENV)
      expect(response.status).toBe(400)
    })

    it('rejects root-level config.json', async () => {
      const response = await uploadFile({ path: 'config.json', content: 'malicious' }, ENV)
      expect(response.status).toBe(400)
    })

    it('rejects .env files', async () => {
      const response = await uploadFile({ path: '.env', content: 'secrets' }, ENV)
      expect(response.status).toBe(400)
    })

    it('rejects workflow files', async () => {
      const response = await uploadFile(
        { path: '.github/workflows/main-validation.yml', content: 'malicious' },
        ENV,
      )
      expect(response.status).toBe(400)
    })
  })

  describe('deleteTrackFiles', () => {
    it('marks allowed music paths as deletable in development mode', async () => {
      const response = await deleteTrackFiles(
        ['public/music/track1.mp3', 'public/music/track2.mp3'],
        ENV,
      )
      expect(response.status).toBe(200)
      const data = (await response.json()) as { results: Array<{ path: string; deleted: boolean }> }
      expect(data.results).toHaveLength(2)
      expect(data.results[0].deleted).toBe(true)
      expect(data.results[1].deleted).toBe(true)
    })

    it('marks non-whitelisted paths as not deleted in development mode', async () => {
      const response = await deleteTrackFiles(
        ['public/music/track1.mp3', 'public/sw.js', 'server/core/router.ts'],
        ENV,
      )
      expect(response.status).toBe(200)
      const data = (await response.json()) as { results: Array<{ path: string; deleted: boolean }> }
      expect(data.results).toHaveLength(3)
      expect(data.results[0].deleted).toBe(true)
      expect(data.results[1].deleted).toBe(false)
      expect(data.results[2].deleted).toBe(false)
    })

    it('treats missing allowed remote files as already deleted', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })))

      const response = await deleteTrackFiles(['public/music/track1.mp3'], REMOTE_ENV)
      expect(response.status).toBe(200)
      const data = (await response.json()) as { results: Array<{ path: string; deleted: boolean }> }

      expect(data.results).toEqual([{ path: 'public/music/track1.mp3', deleted: true }])
    })
  })
})
