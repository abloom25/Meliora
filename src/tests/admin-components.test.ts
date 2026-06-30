import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MusicConfig } from '../types/music'
import LocalTrackEditor from '../admin/components/LocalTrackEditor.vue'
import AdvancedSettingsEditor from '../admin/components/AdvancedSettingsEditor.vue'
import SecurityEditor from '../admin/components/SecurityEditor.vue'
import SiteSettingsEditor from '../admin/components/SiteSettingsEditor.vue'

const adminApiMock = vi.hoisted(() => ({
  changePassword: vi.fn(),
  deleteFiles: vi.fn(),
  uploadFile: vi.fn(),
  testMusicApi: vi.fn(),
}))

vi.mock('../admin/services/admin-api', () => ({
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
  MAX_UPLOAD_SIZE_LABEL: '25MB',
  changePassword: adminApiMock.changePassword,
  deleteFiles: adminApiMock.deleteFiles,
  uploadFile: adminApiMock.uploadFile,
  testMusicApi: adminApiMock.testMusicApi,
}))

function config(patch: Partial<MusicConfig> = {}): MusicConfig {
  return {
    siteName: 'Meliora',
    apiEndpoint: '',
    playlists: [],
    localTracks: [],
    ...patch,
  }
}

function flushPromises() {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

describe('admin consistency components', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('requires an 8 character password before changing admin password', async () => {
    const wrapper = mount(SecurityEditor, { attachTo: document.body })
    const inputs = wrapper.findAll('input')

    await inputs[0].setValue('old-password')
    await inputs[1].setValue('1234567')
    await inputs[2].setValue('1234567')
    await wrapper.find('button.save-button').trigger('click')

    expect(adminApiMock.changePassword).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('新密码至少 8 位')

    wrapper.unmount()
  })

  it('keeps a local track when backend file deletion only partially succeeds', async () => {
    adminApiMock.deleteFiles.mockResolvedValue({
      ok: false,
      results: [
        { path: 'public/music/t1/audio.mp3', deleted: true },
        { path: 'public/music/t1/cover.jpg', deleted: false },
      ],
      error: '部分文件删除失败: public/music/t1/cover.jpg',
    })

    const wrapper = mount(LocalTrackEditor, {
      attachTo: document.body,
      props: {
        tracks: [
          {
            id: 't1',
            title: 'Track 1',
            artist: 'Artist',
            audio: './music/t1/audio.mp3',
            cover: './music/t1/cover.jpg',
          },
        ],
      },
    })

    await wrapper.find('button.remove-button').trigger('click')
    await nextTick()
    await document.body.querySelector<HTMLButtonElement>('.confirm-modal-btn.confirm')?.click()
    await flushPromises()

    expect(adminApiMock.deleteFiles).toHaveBeenCalledWith([
      'public/music/t1/audio.mp3',
      'public/music/t1/cover.jpg',
    ])
    expect(wrapper.emitted('update:tracks')).toBeUndefined()
    expect(document.body.textContent).toContain('部分文件删除失败')

    wrapper.unmount()
  })

  it('waits for FileReader and upload before marking icon upload successful', async () => {
    let resolveUpload!: () => void
    adminApiMock.uploadFile.mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = () => resolve({ ok: true, path: 'public/icon.png' })
      }),
    )

    class FakeFileReader {
      static lastInstance: FakeFileReader | null = null

      result: string | ArrayBuffer | null = null
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null
      onabort: ((event: ProgressEvent<FileReader>) => void) | null = null

      constructor() {
        FakeFileReader.lastInstance = this
      }

      readAsDataURL() {
        // Test double: reading completes only when the test invokes onload.
      }
    }
    vi.stubGlobal('FileReader', FakeFileReader)

    const wrapper = mount(SiteSettingsEditor, {
      props: { config: config() },
    })
    const fileInput = wrapper.find<HTMLInputElement>('input[type="file"]')
    const file = new File(['icon'], 'icon.png', { type: 'image/png' })
    Object.defineProperty(fileInput.element, 'files', {
      value: [file],
      configurable: true,
    })

    const change = fileInput.trigger('change')
    await nextTick()

    expect(wrapper.text()).toContain('上传中...')

    const reader = FakeFileReader.lastInstance
    if (!reader) throw new Error('FileReader was not created')
    reader.result = 'data:image/png;base64,aWNvbg=='
    reader.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>)
    await flushPromises()

    expect(wrapper.text()).toContain('上传中...')
    expect(adminApiMock.uploadFile).toHaveBeenCalledWith('public/icon.png', 'aWNvbg==')

    resolveUpload()
    await change
    await nextTick()

    expect(wrapper.text()).toContain('上传成功')
    expect(wrapper.emitted('update:config')?.[0]).toEqual([{ ...config(), siteIcon: './icon.png' }])
  })

  it('does not offer SVG as an uploadable site icon type', () => {
    const wrapper = mount(SiteSettingsEditor, {
      props: { config: config() },
    })

    const accept = wrapper.find<HTMLInputElement>('input[type="file"]').attributes('accept') || ''
    expect(accept).not.toContain('svg')
    expect(accept).toContain('image/png')

    wrapper.unmount()
  })

  it('updates receive prerelease setting from advanced editor', async () => {
    const baseConfig = { ...config(), githubProxy: 'https://proxy.example.com/' }
    const wrapper = mount(AdvancedSettingsEditor, {
      props: { config: baseConfig },
    })

    await wrapper.find<HTMLInputElement>('input[type="checkbox"]').setValue(true)

    expect(wrapper.emitted('update:config')?.[0]).toEqual([
      { ...baseConfig, receivePrereleaseUpdates: true },
    ])

    expect(wrapper.text()).toContain('接收预发布版本')
    expect(wrapper.text()).toContain('触发更新流程仍需要部署环境可访问')

    wrapper.unmount()
  })
})
