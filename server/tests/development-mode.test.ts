import { describe, expect, it } from 'vitest'
import { resolveDeploymentEnv } from '../../shared/env-schema'
import { isDevelopmentMode, truthy, validateEnv } from '../core/types'
import type { Env } from '../core/types'

const REAL_TOKEN = 'ghp_realtokenvalue1234567890abcdef'
const STRONG_KEY = 'meliora-prod-key-A7f3N9q2R8s5T1u4V6w0'

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GH_TOKEN: REAL_TOKEN,
    GH_REPO: 'test/repo',
    GH_BRANCH: 'main',
    CONFIG_ENCRYPTION_KEY: '',
    ...overrides,
  }
}

describe('isDevelopmentMode', () => {
  it('enters development mode when DEVELOPMENT is truthy, even with a real GH_TOKEN', () => {
    const env = makeEnv({ DEVELOPMENT: 'true' })
    expect(isDevelopmentMode(env)).toBe(true)
  })

  it('accepts common truthy DEVELOPMENT values', () => {
    const env = makeEnv({ DEVELOPMENT: 'yes' })
    expect(isDevelopmentMode(env)).toBe(true)
  })

  it('does not enter development mode with only a real GH_TOKEN (no ghp_ prefix sniffing)', () => {
    const env = makeEnv({ DEVELOPMENT: undefined, GH_TOKEN: 'ghp_xxxxxxxx' })
    expect(isDevelopmentMode(env)).toBe(false)
  })

  it('does not enter development mode when DEVELOPMENT is "false"', () => {
    const env = makeEnv({ DEVELOPMENT: 'false' })
    expect(isDevelopmentMode(env)).toBe(false)
  })

  it('does not enter development mode when DEVELOPMENT is an empty string', () => {
    const env = makeEnv({ DEVELOPMENT: '' })
    expect(isDevelopmentMode(env)).toBe(false)
  })
})

describe('truthy', () => {
  const cases: Array<[string | undefined, boolean]> = [
    ['true', true],
    ['TRUE', true],
    ['True', true],
    ['tRuE', true],
    ['1', true],
    ['yes', true],
    ['YES', true],
    ['Yes', true],
    ['on', true],
    ['ON', true],
    ['On', true],
    ['  true  ', true],
    ['\t1\n', true],
    [' false ', false],
    ['false', false],
    ['0', false],
    ['no', false],
    ['off', false],
    ['', false],
    ['   ', false],
    [undefined, false],
    ['random', false],
    ['yesplease', false],
    ['tru', false],
  ]

  it.each(cases)('truthy(%j) === %s', (value, expected) => {
    expect(truthy(value)).toBe(expected)
  })
})

describe('validateEnv', () => {
  it('accepts a usable GH_TOKEN with a valid repo and strong encryption key in production mode', () => {
    const env = makeEnv({
      GH_TOKEN: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      CONFIG_ENCRYPTION_KEY: STRONG_KEY,
      DEVELOPMENT: '',
    })

    expect(validateEnv(env).ok).toBe(true)
  })

  it('rejects missing or placeholder GH_TOKEN in production mode', () => {
    for (const GH_TOKEN of ['', 'placeholder', 'placeholder-token']) {
      const result = validateEnv(
        makeEnv({
          GH_TOKEN,
          CONFIG_ENCRYPTION_KEY: STRONG_KEY,
          DEVELOPMENT: '',
        }),
      )

      expect(result.ok, GH_TOKEN || '<empty>').toBe(false)
      expect(
        result.errors.some((error) => error.includes('GH_TOKEN')),
        GH_TOKEN || '<empty>',
      ).toBe(true)
    }
  })

  it('rejects missing GH_REPO in production mode', () => {
    const env = makeEnv({
      GH_REPO: '',
      CONFIG_ENCRYPTION_KEY: STRONG_KEY,
      DEVELOPMENT: '',
    })

    const result = validateEnv(env)

    expect(result.ok).toBe(false)
    expect(result.errors.some((error) => error.includes('GH_REPO'))).toBe(true)
  })

  it('rejects GH_REPO values that are not owner/repo in production mode', () => {
    const invalidRepos = [
      'owner',
      'owner/repo/extra',
      'bad_owner/repo',
      '-owner/repo',
      'owner-/repo',
      'owner/repo.git',
      'owner/repo with spaces',
      ' owner/repo',
      'owner/repo ',
    ]

    for (const GH_REPO of invalidRepos) {
      const result = validateEnv(
        makeEnv({
          GH_REPO,
          CONFIG_ENCRYPTION_KEY: STRONG_KEY,
          DEVELOPMENT: '',
        }),
      )
      expect(result.ok, GH_REPO).toBe(false)
      expect(
        result.errors.some((error) => error.includes('GH_REPO')),
        GH_REPO,
      ).toBe(true)
    }
  })
})

describe('resolveDeploymentEnv', () => {
  it('infers the repository and branch from Vercel system variables', () => {
    expect(
      resolveDeploymentEnv({
        VERCEL_GIT_PROVIDER: 'github',
        VERCEL_GIT_REPO_OWNER: 'abloom25',
        VERCEL_GIT_REPO_SLUG: 'MelioraSite',
        VERCEL_GIT_COMMIT_REF: 'production',
      }),
    ).toMatchObject({
      GH_REPO: 'abloom25/MelioraSite',
      GH_BRANCH: 'production',
    })
  })

  it('keeps explicit GitHub settings ahead of platform inference', () => {
    expect(
      resolveDeploymentEnv({
        GH_REPO: 'owner/explicit-repo',
        GH_BRANCH: 'release',
        VERCEL_GIT_REPO_OWNER: 'ignored',
        VERCEL_GIT_REPO_SLUG: 'ignored',
        VERCEL_GIT_COMMIT_REF: 'ignored',
      }),
    ).toMatchObject({
      GH_REPO: 'owner/explicit-repo',
      GH_BRANCH: 'release',
    })
  })

  it('does not infer malformed Vercel repository values', () => {
    expect(
      resolveDeploymentEnv({
        VERCEL_GIT_REPO_OWNER: 'bad_owner',
        VERCEL_GIT_REPO_SLUG: 'repo',
      }).GH_REPO,
    ).toBe('')
  })

  it('does not treat non-GitHub Vercel projects as GitHub repositories', () => {
    expect(
      resolveDeploymentEnv({
        VERCEL_GIT_PROVIDER: 'gitlab',
        VERCEL_GIT_REPO_OWNER: 'owner',
        VERCEL_GIT_REPO_SLUG: 'repo',
      }).GH_REPO,
    ).toBe('')
  })
})
