import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminSidebar from '../admin/components/AdminSidebar.vue'
import ConfigTransferView from '../admin/views/ConfigTransferView.vue'
import type { MusicConfig } from '../types/music'

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

function mountTransfer(config: MusicConfig = validConfig({ siteName: 'Loaded Meliora' })) {
  return mount(ConfigTransferView, {
    attachTo: document.body,
    props: { config },
    global: {
      stubs: {
        ConfirmModal: {
          props: ['visible', 'title', 'cancelText', 'confirmText'],
          emits: ['cancel', 'confirm'],
          template: `
            <section v-if="visible" class="confirm-modal-stub">
              <h3>{{ title }}</h3>
              <div class="confirm-modal-body"><slot /></div>
              <button type="button" class="confirm-modal-btn cancel" @click="$emit('cancel')">
                {{ cancelText || '取消' }}
              </button>
              <button type="button" class="confirm-modal-btn confirm" @click="$emit('confirm')">
                {{ confirmText || '确认' }}
              </button>
            </section>
          `,
        },
      },
    },
  })
}

describe('admin plaintext config import/export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
    window.localStorage.clear()
  })

  it('shows a dedicated migration page entry in the admin sidebar', () => {
    const wrapper = mount(AdminSidebar, {
      props: {
        active: 'transfer',
        config: validConfig(),
        saving: false,
      },
    })

    expect(wrapper.text()).toContain('迁移')
    expect(wrapper.find('.sidebar-tab.active').text()).toContain('迁移')

    wrapper.unmount()
  })

  it('collapses and restores the desktop admin sidebar', async () => {
    const wrapper = mount(AdminSidebar, {
      props: {
        active: 'site',
        config: validConfig(),
        saving: false,
      },
    })

    expect(wrapper.classes()).not.toContain('collapsed')

    await wrapper.get('button[aria-label="折叠管理导航"]').trigger('click')

    expect(wrapper.classes()).toContain('collapsed')
    expect(window.localStorage.getItem('meliora:admin-sidebar-collapsed')).toBe('true')
    expect(wrapper.find('button[aria-label="展开管理导航"]').exists()).toBe(true)

    wrapper.unmount()

    const restored = mount(AdminSidebar, {
      props: {
        active: 'site',
        config: validConfig(),
        saving: false,
      },
    })

    expect(restored.classes()).toContain('collapsed')

    restored.unmount()
  })

  it('waits for the mobile navigation to close before emitting save', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        media: '(max-width: 760px)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    )

    const wrapper = mount(AdminSidebar, {
      attachTo: document.body,
      props: {
        active: 'site',
        config: validConfig(),
        saving: false,
      },
    })

    try {
      await wrapper.get('button[aria-label="打开管理导航"]').trigger('click')
      await vi.advanceTimersByTimeAsync(40)
      await nextTick()

      const mobileSave = document.body.querySelector<HTMLButtonElement>(
        '.mobile-nav-panel .sidebar-save',
      )
      if (!mobileSave) throw new Error('Mobile save button was not rendered')
      mobileSave.click()
      await nextTick()

      expect(wrapper.emitted('save')).toBeUndefined()
      await vi.advanceTimersByTimeAsync(359)
      expect(wrapper.emitted('save')).toBeUndefined()

      await vi.advanceTimersByTimeAsync(1)
      await nextTick()
      expect(wrapper.emitted('save')).toHaveLength(1)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('warns before exporting plaintext JSON and includes sensitive config fields', async () => {
    const exported = { blob: null as Blob | null }
    const createObjectUrl = vi.fn((blob: Blob) => {
      exported.blob = blob
      return 'blob:meliora-config'
    })
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectUrl,
      configurable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectUrl,
      configurable: true,
    })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const config = validConfig({
      siteName: 'Loaded Meliora',
      apiToken: 'plain-api-token',
      githubProxy: 'https://proxy.example.com/?url={url}',
      receivePrereleaseUpdates: true,
    })
    const wrapper = mountTransfer(config)

    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('导出 JSON'))
      ?.trigger('click')
    await flushPromises()

    expect(createObjectUrl).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('导出的 JSON 是明文文件')
    expect(wrapper.text()).toContain('音乐 API Token')
    expect(wrapper.text()).toContain('管理员登录密码不会以明文保存')

    await wrapper.find('.confirm-modal-btn.confirm').trigger('click')
    await flushPromises()

    expect(createObjectUrl).toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:meliora-config')
    expect(exported.blob).not.toBeNull()
    if (!exported.blob) throw new Error('Expected exported config blob to be created')
    expect(JSON.parse(await exported.blob.text())).toEqual(config)

    wrapper.unmount()
  })

  it('asks before importing a valid plaintext JSON config over the current config', async () => {
    const wrapper = mountTransfer()

    const imported = validConfig({
      siteName: 'Imported Meliora',
      apiEndpoint: 'https://music-api.example.com',
      apiToken: 'plain-api-token',
      playlists: [{ server: 'netease', playlistId: '123' }],
    })
    const file = new File([JSON.stringify(imported)], 'meliora-config.json', {
      type: 'application/json',
    })
    const input = wrapper.find<HTMLInputElement>('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      value: [file],
      configurable: true,
    })

    await input.trigger('change')
    await flushPromises()

    expect(wrapper.emitted('update:config')).toBeUndefined()
    expect(wrapper.text()).toContain('覆盖当前配置?')
    expect(wrapper.text()).toContain('导入会用所选 JSON 覆盖当前后台表单中的配置')

    await wrapper.find('.confirm-modal-btn.confirm').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('update:config')?.[0]).toEqual([imported])
    expect(wrapper.emitted('notify')?.[0]).toEqual(['已导入未加密配置,确认无误后请保存', 'success'])

    wrapper.unmount()
  })

  it('rejects invalid plaintext config imports and keeps the existing config', async () => {
    const wrapper = mountTransfer()

    const file = new File([JSON.stringify({ siteName: '', playlists: 'bad' })], 'bad.json', {
      type: 'application/json',
    })
    const input = wrapper.find<HTMLInputElement>('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      value: [file],
      configurable: true,
    })

    await input.trigger('change')
    await flushPromises()

    expect(wrapper.emitted('update:config')).toBeUndefined()
    expect(wrapper.emitted('notify')?.[0]?.[0]).toContain('导入失败:')
    expect(wrapper.emitted('notify')?.[0]?.[0]).toContain('siteName 必须是非空字符串')

    wrapper.unmount()
  })
})
