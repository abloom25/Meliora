import { describe, expect, it } from 'vitest'
import { isPublicHttpUrl, isPublicHttpsUrl } from '../core/types'

describe('isPublicHttpUrl', () => {
  it('rejects localhost and private address literals', () => {
    expect(isPublicHttpUrl('http://localhost:3000')).toBe(false)
    expect(isPublicHttpUrl('http://127.0.0.1')).toBe(false)
    expect(isPublicHttpUrl('http://192.168.1.10')).toBe(false)
    expect(isPublicHttpUrl('http://169.254.169.254')).toBe(false)
  })

  it('rejects IPv4-mapped IPv6 literals that can hide private targets', () => {
    expect(isPublicHttpUrl('http://[::ffff:127.0.0.1]/api')).toBe(false)
    expect(isPublicHttpUrl('http://[::ffff:7f00:1]/api')).toBe(false)
  })

  it('accepts public http and https URLs', () => {
    expect(isPublicHttpUrl('https://api.example.com')).toBe(true)
    expect(isPublicHttpUrl('http://93.184.216.34')).toBe(true)
  })

  it('accepts only public https URLs for server-side outbound integrations', () => {
    expect(isPublicHttpsUrl('https://api.example.com')).toBe(true)
    expect(isPublicHttpsUrl('http://api.example.com')).toBe(false)
    expect(isPublicHttpsUrl('https://127.0.0.1')).toBe(false)
  })
})
