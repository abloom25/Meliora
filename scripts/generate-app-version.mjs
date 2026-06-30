import { mkdir, readFile, writeFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const version = typeof packageJson.version === 'string' ? packageJson.version.trim() : ''
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
if (!semverPattern.test(version)) {
  throw new Error(`package.json version must be valid SemVer, received: ${version || '<empty>'}`)
}
const target = new URL('../src/generated/app-version.ts', import.meta.url)

await mkdir(new URL('.', target), { recursive: true })
await writeFile(
  target,
  `// prettier-ignore\nexport const APP_VERSION = ${JSON.stringify(version)}\n`,
)
