import { describe, expect, it } from 'vitest'
import { buildEdgeEnv } from '../core/env'

describe('buildEdgeEnv', () => {
  it('fills empty defaults when the platform env is missing values', () => {
    expect(buildEdgeEnv({})).toEqual({
      GH_TOKEN: '',
      GH_REPO: '',
      GH_BRANCH: 'main',
      GITHUB_PROXY: '',
      ADMIN_DISABLED: '',
      DEVELOPMENT: '',
      CONFIG_ENCRYPTION_KEY: '',
    })
  })

  it('passes through provided platform env values', () => {
    const env = buildEdgeEnv({
      GH_TOKEN: 'gh-token',
      GH_REPO: 'owner/repo',
      GH_BRANCH: 'dev',
      GITHUB_PROXY: 'https://proxy.example.com/',
      ADMIN_DISABLED: 'true',
      DEVELOPMENT: 'false',
      CONFIG_ENCRYPTION_KEY: 'encryption-key',
    })

    expect(env).toEqual({
      GH_TOKEN: 'gh-token',
      GH_REPO: 'owner/repo',
      GH_BRANCH: 'dev',
      GITHUB_PROXY: 'https://proxy.example.com/',
      ADMIN_DISABLED: 'true',
      DEVELOPMENT: 'false',
      CONFIG_ENCRYPTION_KEY: 'encryption-key',
    })
  })

  it('infers repo and branch from Vercel git metadata when explicit values are absent', () => {
    const env = buildEdgeEnv({
      GH_TOKEN: 'gh-token',
      CONFIG_ENCRYPTION_KEY: 'encryption-key',
      VERCEL_GIT_PROVIDER: 'github',
      VERCEL_GIT_REPO_OWNER: 'abloom25',
      VERCEL_GIT_REPO_SLUG: 'Meliora',
      VERCEL_GIT_COMMIT_REF: 'release',
    })

    expect(env.GH_REPO).toBe('abloom25/Meliora')
    expect(env.GH_BRANCH).toBe('release')
  })
})
