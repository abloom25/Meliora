import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DashboardView from '../admin/views/DashboardView.vue'
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
  useAdminAuth: () => ({
    logout: vi.fn(),
  }),
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

function validConfig(patch: Partial<MusicConfig> = {}): MusicConfig {
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

describe('admin about navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    adminApiMock.fetchConfig.mockResolvedValue(validConfig())
    adminApiMock.checkUpdate.mockResolvedValue({
      ok: false,
      error: '检查失败',
    })
  })

  it('can leave the about page after its automatic update check runs', async () => {
    const wrapper = mount(DashboardView, {
      attachTo: document.body,
      global: {
        stubs: {
          ConfirmModal: true,
          Toast: true,
          SiteSettingsEditor: {
            props: ['config'],
            template: '<section class="site-editor-stub">站点编辑</section>',
          },
          PlaylistEditor: true,
          LocalTrackEditor: true,
          AnalyticsSettingsEditor: true,
          AdvancedSettingsEditor: true,
          SecurityEditor: true,
          ConfigTransferView: true,
        },
      },
    })
    await flushPromises()

    await wrapper
      .findAll('.sidebar-tab')
      .find((button) => button.text().includes('关于'))
      ?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Meliora')
    expect(adminApiMock.checkUpdate).toHaveBeenCalled()

    await wrapper
      .findAll('.sidebar-tab')
      .find((button) => button.text().includes('站点'))
      ?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('站点编辑')

    wrapper.unmount()
  })
})
