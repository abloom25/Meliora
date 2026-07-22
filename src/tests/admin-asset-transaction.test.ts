import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, type PropType } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DashboardView from '../admin/views/DashboardView.vue'
import { useFileStagingState } from '../admin/composables/useFileStagingState'
import type { MusicConfig } from '../types/music'

const adminApiMock = vi.hoisted(() => ({
  fetchConfig: vi.fn(),
  saveConfig: vi.fn(),
  checkUpdate: vi.fn(),
  triggerUpdate: vi.fn(),
  fetchUpdateStatus: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('../admin/composables/useAdminAuth', () => ({
  useAdminAuth: () => ({ logout: vi.fn() }),
}))

vi.mock('../admin/services/admin-api', () => ({
  fetchConfig: adminApiMock.fetchConfig,
  saveConfig: adminApiMock.saveConfig,
  checkUpdate: adminApiMock.checkUpdate,
  triggerUpdate: adminApiMock.triggerUpdate,
  fetchUpdateStatus: adminApiMock.fetchUpdateStatus,
}))

vi.mock('../generated/app-version', () => ({
  APP_VERSION: '0.1.0',
}))

vi.mock('/favicon.svg', () => ({ default: '/favicon.svg' }))

const SiteSettingsStub = defineComponent({
  name: 'SiteSettingsEditor',
  props: {
    config: {
      type: Object as PropType<MusicConfig>,
      required: true,
    },
  },
  emits: ['update:config', 'file-staged', 'notify'],
  setup(props, { emit }) {
    return {
      stageIcon() {
        emit('file-staged', {
          path: 'public/icon.png',
          blobSha: 'a'.repeat(40),
        })
      },
      removeIcon() {
        const { siteIcon, ...nextConfig } = props.config
        void siteIcon
        emit('update:config', nextConfig)
      },
    }
  },
  template: `
    <button class="stage-icon" type="button" @click="stageIcon">暂存图标</button>
    <button class="remove-icon" type="button" @click="removeIcon">移除图标</button>
  `,
})

function config(): MusicConfig {
  return {
    siteName: 'Meliora',
    siteIcon: './icon.png',
    apiEndpoint: '',
    playlists: [],
    localTracks: [],
  }
}

function flushPromises() {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function mountDashboard() {
  return mount(DashboardView, {
    attachTo: document.body,
    global: {
      stubs: {
        Toast: true,
        SiteSettingsEditor: SiteSettingsStub,
        PlaylistEditor: true,
        LocalTrackEditor: true,
        AnalyticsSettingsEditor: true,
        AdvancedSettingsEditor: true,
        SecurityEditor: true,
        ConfigTransferView: true,
        AboutView: true,
      },
    },
  })
}

describe('admin asset transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    localStorage.clear()
    adminApiMock.fetchConfig.mockResolvedValue(config())
    adminApiMock.saveConfig.mockResolvedValue({ ok: true })
  })

  it('treats a same-path replacement as unsaved and sends its blob with config save', async () => {
    const wrapper = mountDashboard()
    await flushPromises()

    await wrapper.find('button.stage-icon').trigger('click')
    expect(wrapper.find('.unsaved-indicator').exists()).toBe(true)

    await wrapper.find('button.sidebar-save').trigger('click')
    await nextTick()
    expect(document.body.textContent).toContain('保存这些更改?')
    expect(document.body.textContent).toContain('发布 1 个新上传或替换的文件')
    document.body.querySelector<HTMLButtonElement>('.confirm-modal-btn.confirm')?.click()
    await flushPromises()

    expect(adminApiMock.saveConfig).toHaveBeenCalledWith(config(), [
      { path: 'public/icon.png', blobSha: 'a'.repeat(40) },
    ])
    expect(wrapper.find('.unsaved-indicator').exists()).toBe(false)
    wrapper.unmount()
  })

  it('drops staged blobs on revert without calling the save API', async () => {
    const wrapper = mountDashboard()
    await flushPromises()

    await wrapper.find('button.stage-icon').trigger('click')
    expect(wrapper.find('.unsaved-indicator').exists()).toBe(true)

    await wrapper.find('button.unsaved-revert').trigger('click')
    await nextTick()
    document.body.querySelector<HTMLButtonElement>('.confirm-modal-btn.confirm.danger')?.click()
    await nextTick()

    expect(wrapper.find('.unsaved-indicator').exists()).toBe(false)
    expect(adminApiMock.saveConfig).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('blocks save and shows progress while a file is still being staged', async () => {
    const wrapper = mountDashboard()
    await flushPromises()
    const finishFileStaging = useFileStagingState().beginFileStaging()

    try {
      await nextTick()
      const saveButton = wrapper.find<HTMLButtonElement>('button.sidebar-save')
      expect(saveButton.attributes('disabled')).toBeDefined()
      expect(saveButton.text()).toContain('暂存文件中...')
      expect(wrapper.find('.unsaved-indicator').text()).toContain('正在暂存 1 个文件')

      await saveButton.trigger('click')
      await nextTick()
      expect(document.body.textContent).not.toContain('保存这些更改?')
    } finally {
      finishFileStaging()
      await nextTick()
      wrapper.unmount()
    }
  })

  it('explains how many old files will be cleaned before saving', async () => {
    const wrapper = mountDashboard()
    await flushPromises()

    await wrapper.find('button.remove-icon').trigger('click')
    await wrapper.find('button.sidebar-save').trigger('click')
    await nextTick()

    expect(document.body.textContent).toContain('清理 1 个已不再使用的旧文件')
    wrapper.unmount()
  })
})
