import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflowPath = join(process.cwd(), '.github/workflows/update-from-upstream.yml')

describe('update workflow safeguards', () => {
  it('keeps GitHub proxy requests from following redirects', async () => {
    const source = await readFile(workflowPath, 'utf8')

    expect(source).toContain('Validate GitHub proxy input')
    expect(source).toContain('curl -fsSL --max-redirs 0')
  })

  it('fully revalidates the temporary branch after merging the latest target branch', async () => {
    const source = await readFile(workflowPath, 'utf8')
    const mergeStep = source.slice(source.indexOf('git merge --no-edit "origin/${TARGET_BRANCH}"'))

    expect(mergeStep).toContain('pnpm install --frozen-lockfile')
    expect(mergeStep).toContain('pnpm test')
    expect(mergeStep).toContain('pnpm type-check')
    expect(mergeStep).toContain('pnpm lint')
    expect(mergeStep).toContain('pnpm format:check')
    expect(mergeStep).toContain('pnpm build')
    expect(mergeStep).toContain('pnpm test:bundle')
  })

  it('does not push temporary update branches to the remote before merging', async () => {
    const source = await readFile(workflowPath, 'utf8')

    expect(source).toContain('Temporary branch is kept local until validation passes.')
    expect(source).not.toContain('git push origin "${TEMP_BRANCH}" --force')
  })

  it('keeps downstream workflow files and formatting rules deployment-owned', async () => {
    const source = await readFile(workflowPath, 'utf8')

    expect(source).toContain("--exclude='.github/workflows/'")
    expect(source).toContain("--exclude='.prettierignore'")
  })

  it('validates updates with the non-secret CI config', async () => {
    const source = await readFile(workflowPath, 'utf8')

    expect(source).toContain('MELIORA_CONFIG_PATH: .github/ci-public-config.json')
  })
})
