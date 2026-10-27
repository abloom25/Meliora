import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref, shallowRef, type Ref } from 'vue'
import LyricShareToolbar from '../components/LyricShareToolbar.vue'
import type { LyricShareSelection } from '../core/lyrics/share'
import type { LyricShareCardInput } from '../platform/web/useLyricShareCard'

const mocks = vi.hoisted(() => ({
  useCard: vi.fn(),
  copy: vi.fn(),
  download: vi.fn(),
  canShare: vi.fn(),
}))
vi.mock('../platform/web/useLyricShareCard', () => ({
  useLyricShareCard: mocks.useCard,
  copyLyricImage: mocks.copy,
  downloadLyricImage: mocks.download,
  canShareLyricImage: mocks.canShare,
}))
const selection: LyricShareSelection = {
  track: { id: 'song', title: 'Song', artist: 'Artist', audioUrl: '/song.mp3', kind: 'local' },
  lines: Array.from({ length: 8 }, (_, index) => ({
    text: `Line ${index}`,
    time: index * 10 + 0.125,
    translation: `译文 ${index}`,
  })),
  index: 3,
}
let input: Ref<LyricShareCardInput | null>
let wrapper: VueWrapper | undefined
const image = new File(['png'], 'song.png', { type: 'image/png' })
const originalShare = Object.getOwnPropertyDescriptor(navigator, 'share')
function open(indices = [3], value = selection, realTransitions = false) {
  wrapper = mount(LyricShareToolbar, {
    props: { visible: true, selection: value, indices },
    attachTo: document.body,
    global: { stubs: { transition: !realTransitions } },
  })
  return wrapper
}
describe('inline lyric share toolbar', () => {
  beforeEach(() => {
    mocks.useCard.mockImplementation((value: Ref<LyricShareCardInput | null>) => {
      input = value
      return {
        previewUrl: ref('blob:preview'),
        loading: ref(false),
        error: ref(''),
        file: shallowRef(image),
        retry: vi.fn(),
      }
    })
    mocks.download.mockReset()
    mocks.copy.mockReset().mockResolvedValue(undefined)
    mocks.canShare.mockReset().mockReturnValue(false)
  })
  afterEach(() => {
    wrapper?.unmount()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
    if (originalShare) Object.defineProperty(navigator, 'share', originalShare)
    else Reflect.deleteProperty(navigator, 'share')
  })
  it('uses the inline selection in song order without opening a modal', async () => {
    const bar = open([6, 3, 1])
    expect(bar.find('[role="dialog"]').exists()).toBe(false)
    expect(input.value?.lines.map((line) => line.text)).toEqual(['Line 1', 'Line 3', 'Line 6'])
    expect(bar.get('[aria-label="预览歌词卡片"]').attributes('aria-expanded')).toBe('false')
    await bar.get('[aria-label="预览歌词卡片"]').trigger('click')
    expect(bar.get('[aria-label="预览歌词卡片"]').attributes('aria-expanded')).toBe('true')
    expect(bar.emitted('preview')).toEqual([[true]])
    expect(bar.get('.preview-scroll').find('.share-footer').exists()).toBe(false)
  })

  it('returns from preview before ending selection and restores keyboard focus after its transition', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0),
    )
    const bar = open([3, 5], selection, true)
    const trigger = bar.get<HTMLButtonElement>('[aria-label="预览歌词卡片"]')
    await trigger.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(bar.get('.preview-scroll').element)
    await bar.get('.download-action').trigger('click')
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(image)
    await bar.get('.preview-scroll').trigger('keydown', { key: 'Escape' })
    expect(bar.emitted('close')).toBeUndefined()
    expect(bar.classes()).toContain('preview-expanded')
    await vi.waitFor(() => {
      expect(bar.classes()).not.toContain('preview-expanded')
      expect(bar.find('.share-preview').exists()).toBe(false)
    })
    expect(bar.emitted('preview')).toEqual([[true], [false]])
    expect(document.activeElement).toBe(trigger.element)
    expect(input.value?.lines).toEqual([selection.lines[3], selection.lines[5]])
    await trigger.trigger('keydown', { key: 'Escape' })
    expect(bar.emitted('close')).toEqual([[]])
  })

  it('clears preview when closed externally and reopens in selection mode', async () => {
    const bar = open()
    const trigger = bar.get('[aria-label="预览歌词卡片"]')
    await trigger.trigger('click')
    await bar.setProps({ visible: false })
    expect(bar.emitted('preview')).toEqual([[true], [false]])
    expect(bar.attributes('inert')).toBeDefined()
    await bar.setProps({ visible: true })
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(bar.find('.share-preview').exists()).toBe(false)
    expect(bar.classes()).not.toContain('preview-expanded')
  })
  it('offers separate copy and download image actions without timestamp links', async () => {
    const bar = open([5, 1, 3])
    expect(bar.find('[aria-label="复制歌词时间链接"]').exists()).toBe(false)
    expect(bar.get('.copy-action').text()).toBe('复制图片')
    expect(bar.get('.download-action').text()).toBe('下载图片')
    expect(bar.find('.share-action').exists()).toBe(false)
    await bar.get('.download-action').trigger('click')
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(image)
    mocks.canShare.mockReturnValue(true)
    // File capability is determined with a new card instance.
    bar.unmount()
    const native = open()
    expect(native.get('.share-action').attributes('aria-label')).toBe('分享图片')
    expect(native.find('.download-action').exists()).toBe(true)
    expect(native.find('.copy-action').exists()).toBe(true)
    await native.get('.download-action').trigger('click')
    expect(mocks.download).toHaveBeenCalledTimes(2)
  })
  it('changes translation without changing the selected lines and disables empty selection', async () => {
    const bar = open()
    await bar.get('[aria-label="预览歌词卡片"]').trigger('click')
    await bar.get('[aria-label="分享卡片包含译文"]').trigger('click')
    expect(input.value?.includeTranslation).toBe(false)
    expect(input.value?.lines).toEqual([selection.lines[3]])
    await bar.setProps({ indices: [] })
    expect(bar.get('.copy-action').attributes('disabled')).toBeDefined()
    expect(bar.get('.download-action').attributes('disabled')).toBeDefined()
  })
  it('makes the outgoing toolbar inert and rejects stale actions', async () => {
    const bar = open()
    await bar.setProps({ visible: false })
    expect(input.value).toBeNull()
    expect(bar.attributes('inert')).toBeDefined()
    await bar.get('.copy-action').trigger('click')
    await bar.get('.download-action').trigger('click')
    expect(mocks.copy).not.toHaveBeenCalled()
    expect(mocks.download).not.toHaveBeenCalled()
  })
  it('cancels selection with Escape without interfering with playback', async () => {
    const bar = open()
    await bar.trigger('keydown', { key: 'Escape' })
    expect(bar.emitted('close')).toEqual([[]])
  })
  it('does not download when native sharing is cancelled', async () => {
    mocks.canShare.mockReturnValue(true)
    const share = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'))
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    const bar = open()
    await bar.get('.share-action').trigger('click')
    await flushPromises()
    expect(share).toHaveBeenCalledExactlyOnceWith({ files: [image] })
    expect(mocks.download).not.toHaveBeenCalled()
  })
  it('downloads when native sharing is unavailable', async () => {
    const bar = open()
    await bar.get('.download-action').trigger('click')
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(image)
  })
  it('ignores a failed native share after selection is closed', async () => {
    let reject!: (error: Error) => void
    mocks.canShare.mockReturnValue(true)
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: vi.fn(
        () =>
          new Promise<void>((_resolve, fail) => {
            reject = fail
          }),
      ),
    })
    const bar = open()
    await bar.get('.share-action').trigger('click')
    await bar.setProps({ visible: false })
    reject(new Error('Failed'))
    await flushPromises()
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('copies the prepared image once, keeps pending actions disabled, and confirms completion', async () => {
    let resolve!: () => void
    mocks.copy.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done
      }),
    )
    const bar = open()
    await bar.get('.copy-action').trigger('click')
    expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(image)
    expect(bar.get('.copy-action').attributes('aria-busy')).toBe('true')
    expect(bar.get('.download-action').attributes('disabled')).toBeDefined()
    await bar.get('.copy-action').trigger('click')
    expect(mocks.copy).toHaveBeenCalledOnce()
    expect(mocks.download).not.toHaveBeenCalled()
    resolve()
    await flushPromises()
    expect(bar.get('.share-notice').text()).toBe('图片已复制，可直接粘贴')
    expect(bar.get('.copy-action').attributes('disabled')).toBeUndefined()
  })

  it('shows a copy failure while leaving explicit download available', async () => {
    mocks.copy.mockRejectedValue(new Error('当前浏览器不支持复制图片，请使用下载图片。'))
    const bar = open()
    await bar.get('.copy-action').trigger('click')
    await flushPromises()
    expect(bar.get('.share-notice').text()).toContain('不支持复制图片')
    expect(mocks.download).not.toHaveBeenCalled()
    await bar.get('.download-action').trigger('click')
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(image)
    expect(bar.get('.share-notice').text()).toBe('图片已开始下载')
  })

  it('ignores a copy completion after selection changes', async () => {
    let resolve!: () => void
    mocks.copy.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done
      }),
    )
    const bar = open()
    await bar.get('.copy-action').trigger('click')
    await bar.setProps({ indices: [5] })
    resolve()
    await flushPromises()
    expect(bar.get('.share-notice').text()).not.toContain('图片已复制')
    expect(bar.get('.copy-action').attributes('disabled')).toBeUndefined()
  })

  it('ignores a failed copy after closing and does not clear a new pending copy', async () => {
    let reject!: (error: Error) => void
    let resolve!: () => void
    mocks.copy
      .mockReturnValueOnce(
        new Promise<void>((_done, fail) => {
          reject = fail
        }),
      )
      .mockReturnValueOnce(
        new Promise<void>((done) => {
          resolve = done
        }),
      )
    const bar = open()
    await bar.get('.copy-action').trigger('click')
    await bar.setProps({ visible: false })
    await bar.setProps({ visible: true })
    await bar.get('.copy-action').trigger('click')
    reject(new Error('Old permission failure'))
    await flushPromises()
    expect(bar.get('.share-notice').text()).not.toContain('Old permission failure')
    expect(bar.get('.copy-action').attributes('aria-busy')).toBe('true')
    resolve()
    await flushPromises()
    expect(bar.get('.copy-action').attributes('aria-busy')).toBe('false')
  })
})
