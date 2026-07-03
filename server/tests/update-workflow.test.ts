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
})
