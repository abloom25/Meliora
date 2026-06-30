import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const devStaticDir = join('.wrangler', 'pages-dev-static')

await mkdir(devStaticDir, { recursive: true })
await writeFile(
  join(devStaticDir, '.keep'),
  'Static files are served by Vite during local full-stack development.\n',
)
