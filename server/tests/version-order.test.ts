import { describe, expect, it } from 'vitest'
import { compareSemver } from '../../shared/version'

describe('SemVer prerelease ordering', () => {
  it('compares identifiers by ASCII rather than locale collation', () => {
    expect(compareSemver('1.0.0-B', '1.0.0-a')).toBeLessThan(0)
    expect(compareSemver('1.0.0-Z', '1.0.0-a')).toBeLessThan(0)
  })

  it('distinguishes numeric prerelease identifiers beyond Number precision', () => {
    expect(compareSemver('1.0.0-9007199254740992', '1.0.0-9007199254740993')).toBeLessThan(0)
  })

  it('distinguishes core version numbers beyond Number precision', () => {
    expect(compareSemver('9007199254740992.0.0', '9007199254740993.0.0')).toBeLessThan(0)
  })
})
