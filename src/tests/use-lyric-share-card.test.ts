import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, shallowRef, type EffectScope } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { renderLyricShareCard } from '../platform/web/lyric-share-card'
import {
  useLyricShareCard,
  canShareLyricImage,
  copyLyricImage,
  downloadLyricImage,
  type LyricShareCardInput,
} from '../platform/web/useLyricShareCard'

const clearRenderer = vi.hoisted(() => vi.fn())
vi.mock('../platform/web/lyric-share-card', () => {
  const render = vi.fn()
  return {
    renderLyricShareCard: render,
    createLyricShareCardRenderer: () => ({ render, clear: clearRenderer }),
  }
})

const scopes: EffectScope[] = []
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
const navigatorProperties = ['share', 'canShare', 'clipboard'] as const
const originalNavigator = navigatorProperties.map(
  (key) => [key, Object.getOwnPropertyDescriptor(navigator, key)] as const,
)

function input(text = 'First'): LyricShareCardInput {
  return {
    track: { id: 'song', title: 'Song', artist: 'Artist', audioUrl: '/song.mp3', kind: 'local' },
    lines: [{ time: 12, text }],
    includeTranslation: true,
  }
}

function deferred() {
  let resolve!: (blob: Blob) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Blob>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function setup(value: LyricShareCardInput | null = input()) {
  const current = shallowRef(value)
  const scope = effectScope()
  scopes.push(scope)
  const card = scope.run(() => useLyricShareCard(current))!
  return { current, scope, card }
}

describe('lyric share card lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearRenderer.mockClear()
    vi.mocked(renderLyricShareCard).mockReset()
    let serial = 0
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => `blob:card-${++serial}`),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    scopes.splice(0).forEach((scope) => scope.stop())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate)
    else Reflect.deleteProperty(URL, 'createObjectURL')
    if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
    else Reflect.deleteProperty(URL, 'revokeObjectURL')
    for (const [key, descriptor] of originalNavigator) {
      if (descriptor) Object.defineProperty(navigator, key, descriptor)
      else Reflect.deleteProperty(navigator, key)
    }
    document.body.innerHTML = ''
  })

  it('aborts a superseded render and ignores its late successful result', async () => {
    const old = deferred()
    const latest = deferred()
    vi.mocked(renderLyricShareCard)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(latest.promise)
    const { current, card } = setup()
    const oldSignal = vi.mocked(renderLyricShareCard).mock.calls[0]![1]!
    current.value = input('New')
    await nextTick()
    expect(oldSignal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(120)
    const newest = new Blob(['new'], { type: 'image/png' })
    latest.resolve(newest)
    await flushPromises()
    expect(card.previewUrl.value).toBe('blob:card-1')
    expect(card.file.value?.name).toBe('Song-歌词.png')
    old.resolve(new Blob(['old'], { type: 'image/png' }))
    await flushPromises()
    expect(URL.createObjectURL).toHaveBeenCalledExactlyOnceWith(newest)
    expect(card.previewUrl.value).toBe('blob:card-1')
    expect(card.loading.value).toBe(false)
  })

  it('releases replaced previews and all resources when closed during a render', async () => {
    vi.mocked(renderLyricShareCard)
      .mockResolvedValueOnce(new Blob(['first']))
      .mockResolvedValueOnce(new Blob(['second']))
    const { current, card } = setup()
    await flushPromises()
    current.value = input('Second')
    await nextTick()
    await vi.advanceTimersByTimeAsync(120)
    await flushPromises()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:card-1')
    expect(card.previewUrl.value).toBe('blob:card-2')
    const pending = deferred()
    vi.mocked(renderLyricShareCard).mockReturnValueOnce(pending.promise)
    current.value = input('Third')
    await nextTick()
    await vi.advanceTimersByTimeAsync(120)
    const signal = vi.mocked(renderLyricShareCard).mock.calls.at(-1)![1]!
    expect(card.file.value).toBeNull()
    current.value = null
    await nextTick()
    expect(signal.aborted).toBe(true)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:card-2')
    expect(card.previewUrl.value).toBe('')
    expect(card.loading.value).toBe(false)
    pending.resolve(new Blob(['late']))
    await flushPromises()
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
    expect(card.file.value).toBeNull()
  })

  it('does not let an old failed render clear a newer preview', async () => {
    const old = deferred()
    vi.mocked(renderLyricShareCard)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(new Blob(['new']))
    const { current, card } = setup()
    current.value = input('New')
    await nextTick()
    await vi.advanceTimersByTimeAsync(120)
    await flushPromises()
    old.reject(new Error('Old failure'))
    await flushPromises()
    expect(card.previewUrl.value).toBe('blob:card-1')
    expect(card.error.value).toBe('')
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it('clears an empty selection and releases its object URL on scope disposal', async () => {
    vi.mocked(renderLyricShareCard).mockResolvedValue(new Blob(['image']))
    const { current, scope, card } = setup()
    await flushPromises()
    current.value = { ...input(), lines: [] }
    await nextTick()
    expect(card.file.value).toBeNull()
    expect(card.previewUrl.value).toBe('')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:card-1')
    current.value = input()
    await nextTick()
    await vi.advanceTimersByTimeAsync(120)
    await flushPromises()
    scope.stop()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:card-2')
  })

  it('aborts an unfinished render when its owner is disposed', async () => {
    const pending = deferred()
    vi.mocked(renderLyricShareCard).mockReturnValue(pending.promise)
    const { scope, card } = setup()
    const signal = vi.mocked(renderLyricShareCard).mock.calls[0]![1]!
    scope.stop()
    expect(signal.aborted).toBe(true)
    pending.resolve(new Blob(['late']))
    await flushPromises()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(card.file.value).toBeNull()
  })

  it('batches rapid selections, disables stale exports immediately and cancels queued work on close', async () => {
    vi.mocked(renderLyricShareCard).mockResolvedValue(new Blob(['image']))
    const { current, scope, card } = setup()
    await flushPromises()
    current.value = input('Second')
    expect(card.file.value).toBeNull()
    expect(card.previewUrl.value).toBe('blob:card-1')
    expect(card.loading.value).toBe(true)
    await vi.advanceTimersByTimeAsync(60)
    current.value = input('Latest')
    await vi.advanceTimersByTimeAsync(119)
    expect(renderLyricShareCard).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(renderLyricShareCard).toHaveBeenCalledTimes(2)
    expect(vi.mocked(renderLyricShareCard).mock.calls[1]?.[0].lines[0]?.text).toBe('Latest')
    current.value = input('Cancelled')
    scope.stop()
    await vi.advanceTimersByTimeAsync(120)
    expect(renderLyricShareCard).toHaveBeenCalledTimes(2)
    expect(clearRenderer).toHaveBeenCalledOnce()
    expect(card.previewUrl.value).toBe('')
  })

  it('retries a current render failure without retaining an obsolete image', async () => {
    vi.mocked(renderLyricShareCard)
      .mockRejectedValueOnce(new Error('卡片生成失败'))
      .mockResolvedValueOnce(new Blob(['retry']))
    const { card } = setup()
    await flushPromises()
    expect(card.error.value).toBe('卡片生成失败')
    expect(card.loading.value).toBe(false)
    await card.retry()
    expect(vi.mocked(renderLyricShareCard).mock.calls.at(-1)?.[2]).toEqual({ retryCover: true })
    expect(card.error.value).toBe('')
    expect(card.file.value).not.toBeNull()
  })

  it('reports native file sharing unavailable when capability detection throws', () => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: vi.fn() })
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: vi.fn(() => {
        throw new Error('Unavailable')
      }),
    })
    expect(canShareLyricImage(new File(['image'], 'image.png'))).toBe(false)
  })

  it('downloads with a temporary link and releases its URL after the download can consume it', async () => {
    vi.useFakeTimers()
    const clicked: HTMLAnchorElement[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this)
    })
    const file = new File(['image'], 'image.png')
    downloadLyricImage(file)
    expect(click).toHaveBeenCalledTimes(1)
    const anchor = clicked[0]!
    expect(anchor.download).toBe('image.png')
    expect(anchor.href).toBe('blob:card-1')
    expect(document.querySelector('a[download]')).toBeNull()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:card-1')
  })

  function mockClipboard() {
    const write = vi.fn().mockResolvedValue(undefined)
    const items: Array<Record<string, Blob>> = []
    const supports = vi.fn(() => true)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } })
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal(
      'ClipboardItem',
      class {
        static supports = supports
        constructor(data: Record<string, Blob>) {
          items.push(data)
        }
      },
    )
    return { write, items, supports }
  }

  it('writes the exact prepared PNG immediately, without re-rendering or copying text', async () => {
    const { write, items } = mockClipboard()
    const file = new File(['png'], 'lyrics.png', { type: 'image/png' })
    const pending = copyLyricImage(file)
    expect(write).toHaveBeenCalledOnce()
    expect(items).toEqual([{ 'image/png': file }])
    expect(write.mock.calls[0]![0][0]).toBeInstanceOf(ClipboardItem)
    await pending
    expect(renderLyricShareCard).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it.each(['insecure', 'clipboard', 'constructor', 'format'])(
    'reports unavailable image copying: %s',
    async (reason) => {
      const { write, supports } = mockClipboard()
      if (reason === 'insecure') vi.stubGlobal('isSecureContext', false)
      if (reason === 'clipboard')
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
      if (reason === 'constructor') vi.stubGlobal('ClipboardItem', undefined)
      if (reason === 'format') supports.mockReturnValue(false)
      await expect(
        copyLyricImage(new File(['png'], 'lyrics.png', { type: 'image/png' })),
      ).rejects.toThrow('请使用下载图片')
      expect(write).not.toHaveBeenCalled()
    },
  )

  it('supports older clipboard implementations without supports() and rejects a non-PNG file', async () => {
    const { write } = mockClipboard()
    Reflect.deleteProperty(ClipboardItem, 'supports')
    await copyLyricImage(new File(['png'], 'lyrics.png', { type: 'image/png' }))
    expect(write).toHaveBeenCalledOnce()
    await expect(
      copyLyricImage(new File(['jpeg'], 'lyrics.jpg', { type: 'image/jpeg' })),
    ).rejects.toThrow('图片尚未准备好')
    expect(write).toHaveBeenCalledOnce()
  })

  it.each(['NotAllowedError', 'SecurityError', 'UnknownError'])(
    'reports clipboard write failure: %s',
    async (name) => {
      const { write } = mockClipboard()
      write.mockRejectedValue(new DOMException('Write failed', name))
      await expect(
        copyLyricImage(new File(['png'], 'lyrics.png', { type: 'image/png' })),
      ).rejects.toThrow(name === 'UnknownError' ? '图片复制失败' : '复制图片未获授权')
      expect(URL.createObjectURL).not.toHaveBeenCalled()
    },
  )
})
