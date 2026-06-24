import { describe, expect, it } from 'vitest'
import { uploadFile, deleteTrackFiles } from '../core/upload-handler'
import type { Env } from '../core/types'

const ENV: Env = {
  GH_TOKEN: 'placeholder',
  GH_REPO: 'owner/repo',
  GH_BRANCH: 'main',
  CONFIG_ENCRYPTION_KEY: '',
}

describe('upload-handler path whitelist', () => {
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

    it('allows paths under public/', async () => {
      const response = await uploadFile(
        { path: 'public/music/DEVOTION/audio.flac', content: 'data' },
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
        { path: '.github/workflows/deploy-pages.yml', content: 'malicious' },
        ENV,
      )
      expect(response.status).toBe(400)
    })
  })

  describe('deleteTrackFiles', () => {
    it('marks public/ paths as deletable in local mode', async () => {
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

    it('marks non-whitelisted paths as not deleted in local mode', async () => {
      const response = await deleteTrackFiles(
        ['public/music/track1.mp3', 'server/core/router.ts'],
        ENV,
      )
      expect(response.status).toBe(200)
      const data = (await response.json()) as { results: Array<{ path: string; deleted: boolean }> }
      expect(data.results).toHaveLength(2)
      expect(data.results[0].deleted).toBe(true)
      expect(data.results[1].deleted).toBe(false)
    })
  })
})
