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
