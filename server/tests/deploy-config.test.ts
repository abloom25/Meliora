import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('deployment routing and service worker policy', () => {
  it('keeps Netlify API rewrite before the SPA fallback in _redirects', async () => {
    const redirects = await readFile(join(process.cwd(), 'public/_redirects'), 'utf8')
    const rules = redirects
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    expect(rules[0]).toBe('/api/* /.netlify/functions/api/:splat 200')
    expect(rules.indexOf('/api/* /.netlify/functions/api/:splat 200')).toBeLessThan(
      rules.indexOf('/* /index.html 200'),
    )
  })

  it('excludes mutable admin-uploaded assets from service worker cache handling', async () => {
    const serviceWorker = await readFile(join(process.cwd(), 'public/sw.js'), 'utf8')

    expect(serviceWorker).toContain('MUTABLE_ASSET_PATTERN')
    expect(serviceWorker).toContain("requestUrl.pathname.startsWith('/api/')")
    expect(serviceWorker).toContain('MUTABLE_ASSET_PATTERN.test(requestUrl.pathname)')
  })
})

const HSTS_VALUE = 'max-age=31536000; includeSubDomains'
const FRAME_ANCESTORS_DIRECTIVE = "frame-ancestors 'none'; "

interface VercelHeaderEntry {
  key: string
  value: string
}

async function readProjectFile(path: string): Promise<string> {
  return readFile(join(process.cwd(), path), 'utf8')
}

function extractVercelWildcardHeaders(config: string): VercelHeaderEntry[] {
  const parsed = JSON.parse(config) as {
    headers: Array<{ source: string; headers: VercelHeaderEntry[] }>
  }
  const block = parsed.headers.find((entry) => entry.source === '/(.*)')
  if (!block) throw new Error('vercel.json is missing the wildcard header block')
  return block.headers
}

function requireMatch(content: string, pattern: RegExp, source: string): string {
  const match = content.match(pattern)
  if (!match) throw new Error(`${source} is missing a Content-Security-Policy definition`)
  return match[1]
}

async function extractHeaderCsps(): Promise<{ netlify: string; vercel: string; headers: string }> {
  const [netlifyToml, vercelJson, headersFile] = await Promise.all([
    readProjectFile('netlify.toml'),
    readProjectFile('vercel.json'),
    readProjectFile('public/_headers'),
  ])

  const netlify = requireMatch(netlifyToml, /Content-Security-Policy = "([^"]+)"/, 'netlify.toml')
  const vercelEntry = extractVercelWildcardHeaders(vercelJson).find(
    (entry) => entry.key === 'Content-Security-Policy',
  )
  if (!vercelEntry) throw new Error('vercel.json is missing a Content-Security-Policy definition')
  const headers = requireMatch(
    headersFile,
    /Content-Security-Policy: ([^\r\n]+)/,
    'public/_headers',
  )

  return { netlify, vercel: vercelEntry.value, headers }
}

describe('security headers consistency', () => {
  it('serves HSTS on the wildcard route of every deployment platform', async () => {
    const [netlifyToml, vercelJson, headersFile] = await Promise.all([
      readProjectFile('netlify.toml'),
      readProjectFile('vercel.json'),
      readProjectFile('public/_headers'),
    ])

    expect(netlifyToml).toContain(`Strict-Transport-Security = "${HSTS_VALUE}"`)
    expect(headersFile).toContain(`Strict-Transport-Security: ${HSTS_VALUE}`)
    expect(extractVercelWildcardHeaders(vercelJson)).toContainEqual({
      key: 'Strict-Transport-Security',
      value: HSTS_VALUE,
    })
  })

  it('keeps the response-header CSP byte-identical across platforms', async () => {
    const csps = await extractHeaderCsps()

    expect(csps.netlify).toBe(csps.vercel)
    expect(csps.headers).toBe(csps.vercel)
    expect(csps.vercel).toContain(FRAME_ANCESTORS_DIRECTIVE.trim())
  })

  it('keeps the index.html meta CSP aligned with the header policy', async () => {
    const csps = await extractHeaderCsps()
    const html = await readProjectFile('index.html')
    const metaCsp = requireMatch(
      html,
      /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/,
      'index.html',
    )

    // frame-ancestors 在 meta 中会被浏览器忽略，仅由响应头提供；其余指令必须与响应头逐字一致
    expect(metaCsp).not.toContain('frame-ancestors')
    expect(metaCsp).toBe(csps.vercel.replace(FRAME_ANCESTORS_DIRECTIVE, ''))
  })
})
