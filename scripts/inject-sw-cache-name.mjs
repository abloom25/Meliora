import { readFile, writeFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const version = typeof packageJson.version === 'string' ? packageJson.version.trim() : ''
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
if (!semverPattern.test(version)) {
  throw new Error(`package.json version must be valid SemVer, received: ${version || '<empty>'}`)
}
const cacheName = `meliora-shell-v${version}`
const swPath = new URL('../dist/sw.js', import.meta.url)

let content
try {
  content = await readFile(swPath, 'utf8')
} catch {
  console.log('[inject-sw-cache-name] dist/sw.js not found, skipping')
  process.exit(0)
}

const updated = content.replaceAll('__SW_CACHE_NAME__', cacheName)
if (updated === content) {
  throw new Error('[inject-sw-cache-name] __SW_CACHE_NAME__ placeholder not found in dist/sw.js')
}
await writeFile(swPath, updated)
console.log(`[inject-sw-cache-name] injected CACHE_NAME=${cacheName} into dist/sw.js`)
