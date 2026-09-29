import { describe, expect, it } from 'vitest'
import { LruCache } from '../core/util/lru-cache'

describe('LruCache', () => {
  it('stores and retrieves values by key', () => {
    const cache = new LruCache<string, number>(4)
    cache.set('a', 1)
    cache.set('b', 2)

    expect(cache.has('a')).toBe(true)
    expect(cache.has('missing')).toBe(false)
    expect(cache.get('a')).toBe(1)
    expect(cache.get('missing')).toBeUndefined()
    expect(cache.size).toBe(2)
  })

  it('overwrites an existing key without growing size', () => {
    const cache = new LruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('a', 99)

    expect(cache.size).toBe(1)
    expect(cache.get('a')).toBe(99)
  })

  it('evicts the least recently used entry when exceeding capacity', () => {
    const cache = new LruCache<string, number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    // 容量已满，再写入应淘汰最久未访问的 'a'
    cache.set('d', 4)

    expect(cache.size).toBe(3)
    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(true)
    expect(cache.has('c')).toBe(true)
    expect(cache.has('d')).toBe(true)
  })

  it('does not evict an entry that was recently accessed via get', () => {
    const cache = new LruCache<string, number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)

    // 访问 'a'，将其刷新为最近使用
    expect(cache.get('a')).toBe(1)
    // 写入新项，此时最久未访问的是 'b'，应淘汰 'b' 而非 'a'
    cache.set('d', 4)

    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(false)
    expect(cache.has('c')).toBe(true)
    expect(cache.has('d')).toBe(true)
    expect(cache.size).toBe(3)
  })

  it('refreshes access order when updating an existing key via set', () => {
    const cache = new LruCache<string, number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)

    // 重新 set 'a'，将其刷新为最近使用
    cache.set('a', 10)
    // 写入新项，最久未访问的是 'b'，应淘汰 'b'
    cache.set('d', 4)

    expect(cache.has('a')).toBe(true)
    expect(cache.get('a')).toBe(10)
    expect(cache.has('b')).toBe(false)
  })

  it('reduces size after delete and allows the key to be re-added', () => {
    const cache = new LruCache<string, number>(3)
    cache.set('a', 1)
    cache.set('b', 2)

    expect(cache.delete('a')).toBe(true)
    expect(cache.delete('missing')).toBe(false)
    expect(cache.size).toBe(1)
    expect(cache.has('a')).toBe(false)

    // 删除后该槽位可被复用，不会错误淘汰
    cache.set('c', 3)
    cache.set('d', 4)
    expect(cache.size).toBe(3)
    expect(cache.has('b')).toBe(true)
    expect(cache.has('c')).toBe(true)
    expect(cache.has('d')).toBe(true)
  })

  it('respects the configured capacity boundary', () => {
    const cache = new LruCache<number, string>(5)
    for (let i = 0; i < 10; i++) cache.set(i, `v${i}`)

    expect(cache.size).toBe(5)
    // 最旧的 5 个 (0..4) 应被淘汰，保留 5..9
    for (let i = 0; i < 5; i++) expect(cache.has(i)).toBe(false)
    for (let i = 5; i < 10; i++) expect(cache.has(i)).toBe(true)
  })

  it('uses the default capacity of 64 when none is provided', () => {
    const cache = new LruCache<number, number>()
    for (let i = 0; i < 80; i++) cache.set(i, i)

    expect(cache.size).toBe(64)
    expect(cache.has(15)).toBe(false)
    expect(cache.has(16)).toBe(true)
    expect(cache.get(79)).toBe(79)
  })

  it('clear empties the cache', () => {
    const cache = new LruCache<string, number>(4)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.clear()

    expect(cache.size).toBe(0)
    expect(cache.has('a')).toBe(false)
    cache.set('c', 3)
    expect(cache.get('c')).toBe(3)
  })
})
