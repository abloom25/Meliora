import { describe, expect, it } from 'vitest'
import router from '../router'

describe('router', () => {
  it('resolves known app routes', () => {
    expect(router.resolve('/').name).toBe('player')
    expect(router.resolve('/admin').name).toBe('admin')
  })

  it('resolves unknown paths to the not found page', () => {
    const resolved = router.resolve('/missing/page?from=test')

    expect(resolved.name).toBe('not-found')
    expect(resolved.fullPath).toBe('/missing/page?from=test')
  })
})
