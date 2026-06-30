import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const distDir = join(process.cwd(), 'dist')
const textExtensions = new Set([
  '',
  '.css',
  '.html',
  '.js',
  '.json',
  '.svg',
  '.txt',
  '.webmanifest',
  '.xml',
])

const forbiddenEverywhere = [
  '/api/runtime-config',
  'loadRuntimeConfig',
  'secret-token',
  'nested-secret-token',
]

const adminOnlyFieldNames = ['apiToken', 'githubProxy']

async function listTextFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return listTextFiles(path)
      if (!entry.isFile()) return []
      return textExtensions.has(extname(entry.name)) ? [path] : []
    }),
  )
  return files.flat()
}

function isAdminOrSharedBundle(path: string): boolean {
  const name = basename(path)
  return name.startsWith('AdminApp-') || name.startsWith('index-')
}

describe('built bundle leakage checks', () => {
  it.skipIf(!existsSync(distDir))(
    'does not ship removed runtime config or known secrets',
    async () => {
      const files = await listTextFiles(distDir)
      const leaks: string[] = []

      await Promise.all(
        files.map(async (file) => {
          const content = await readFile(file, 'utf8')
          const rel = relative(distDir, file)

          for (const needle of forbiddenEverywhere) {
            if (content.includes(needle)) {
              leaks.push(`${rel}: contains ${needle}`)
            }
          }

          for (const fieldName of adminOnlyFieldNames) {
            if (content.includes(fieldName) && !isAdminOrSharedBundle(file)) {
              leaks.push(`${rel}: contains admin-only field ${fieldName}`)
            }
          }
        }),
      )

      expect(leaks).toEqual([])
    },
  )
})
