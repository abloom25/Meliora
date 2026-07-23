import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AboutView from '../admin/views/AboutView.vue'
import { useUpdateStatus } from '../admin/composables/useUpdateStatus'

const adminApiMock = vi.hoisted(() => ({
  checkUpdate: vi.fn(),
  triggerUpdate: vi.fn(),
  fetchUpdateStatus: vi.fn(),
}))

vi.mock('../admin/services/admin-api', () => ({
  checkUpdate: adminApiMock.checkUpdate,
  triggerUpdate: adminApiMock.triggerUpdate,
  fetchUpdateStatus: adminApiMock.fetchUpdateStatus,
}))

vi.mock('../generated/app-version', () => ({
  APP_VERSION: '0.1.0',
}))

vi.mock('/favicon.svg', () => ({
  default: '/favicon.svg',
}))

function flushPromises() {
  return Promise.resolve()
}

function mockCheckUpdateWithUpdate() {
  adminApiMock.checkUpdate.mockResolvedValue({
    ok: true,
    data: {
      hasUpdate: true,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      targetTag: 'v0.2.0',
      releaseNotes: 'notes',
      releaseUrl: 'https://example.com/release',
      publishedAt: '2026-07-01T00:00:00.000Z',
    },
  })
}

function mockTriggerUpdate() {
  adminApiMock.triggerUpdate.mockResolvedValue({
    ok: true,
    message: 'triggered',
    triggeredAt: '2026-07-02T00:00:00.000Z',
    triggerId: 'trigger-1',
  })
}

describe('AboutView update polling', () => {
  afterEach(() => {
    useUpdateStatus().resetUpdateStatus()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('uses retryAfterSeconds from the update status response', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    mockCheckUpdateWithUpdate()
    mockTriggerUpdate()
    adminApiMock.fetchUpdateStatus.mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        run: {
          id: 1,
          runNumber: 2,
          runAttempt: 1,
          event: 'workflow_dispatch',
          branch: 'main',
          status: 'in_progress',
          conclusion: null,
          displayStatus: 'running',
          createdAt: '2026-07-02T00:00:01.000Z',
          updatedAt: '2026-07-02T00:00:02.000Z',
          htmlUrl: 'https://github.com/owner/repo/actions/runs/1',
        },
        message: 'running',
        retryAfterSeconds: 9,
      },
    })

    const wrapper = mount(AboutView, {
      props: { config: { siteName: 'Meliora', apiEndpoint: '', playlists: [], localTracks: [] } },
    })
    await flushPromises()

    await (wrapper.vm as unknown as { handleUpdate: () => Promise<void> }).handleUpdate()
    await flushPromises()

    expect(adminApiMock.fetchUpdateStatus).toHaveBeenCalledWith(
      '2026-07-02T00:00:00.000Z',
      'trigger-1',
      expect.any(AbortSignal),
    )
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 9000)
    expect(wrapper.find('.update-message').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders update failures in a single status card', async () => {
    mockCheckUpdateWithUpdate()
    mockTriggerUpdate()
    adminApiMock.fetchUpdateStatus.mockResolvedValue({
      ok: false,
      error: 'GitHub workflow runs failed: 403: Resource not accessible',
    })

    const wrapper = mount(AboutView, {
      props: { config: { siteName: 'Meliora', apiEndpoint: '', playlists: [], localTracks: [] } },
    })
    await flushPromises()

    const { pollUpdateStatus } = useUpdateStatus()
    await (wrapper.vm as unknown as { handleUpdate: () => Promise<void> }).handleUpdate()
    await flushPromises()
    await pollUpdateStatus()
    await flushPromises()
    await pollUpdateStatus()
    await flushPromises()

    expect(wrapper.find('.update-message').exists()).toBe(false)
    expect(wrapper.findAll('.update-status')).toHaveLength(1)
    expect(wrapper.text()).toContain('GitHub workflow runs failed: 403: Resource not accessible')
    wrapper.unmount()
  })

  it('keeps polling after AboutView unmounts and restores status on remount', async () => {
    vi.useFakeTimers()
    mockCheckUpdateWithUpdate()
    mockTriggerUpdate()
    adminApiMock.fetchUpdateStatus.mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        run: {
          id: 1,
          runNumber: 2,
          runAttempt: 1,
          event: 'workflow_dispatch',
          branch: 'main',
          status: 'in_progress',
          conclusion: null,
          displayStatus: 'running',
          createdAt: '2026-07-02T00:00:01.000Z',
          updatedAt: '2026-07-02T00:00:02.000Z',
          htmlUrl: 'https://github.com/owner/repo/actions/runs/1',
        },
        message: 'running',
      },
    })

    const wrapper = mount(AboutView, {
      props: { config: { siteName: 'Meliora', apiEndpoint: '', playlists: [], localTracks: [] } },
    })
    await flushPromises()
    await (wrapper.vm as unknown as { handleUpdate: () => Promise<void> }).handleUpdate()
    await flushPromises()
    expect(adminApiMock.fetchUpdateStatus).toHaveBeenCalledTimes(1)

    // 卸载组件(模拟 Dashboard 切 tab):轮询必须继续
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(5000)
    expect(adminApiMock.fetchUpdateStatus).toHaveBeenCalledTimes(2)

    // 重新挂载:恢复进行中的更新状态显示,且已有轮询在跑,不会重复触发
    const remounted = mount(AboutView, {
      props: { config: { siteName: 'Meliora', apiEndpoint: '', playlists: [], localTracks: [] } },
    })
    await flushPromises()
    expect(remounted.find('.update-status').exists()).toBe(true)
    expect(remounted.text()).toContain('正在自动同步代码并执行验证')
    expect(adminApiMock.fetchUpdateStatus).toHaveBeenCalledTimes(2)
    remounted.unmount()
  })

  it('runs the automatic update check without marking auth as expired', async () => {
    adminApiMock.checkUpdate.mockResolvedValue({ ok: false, error: '登录已过期,请重新登录' })

    const wrapper = mount(AboutView, {
      props: { config: { siteName: 'Meliora', apiEndpoint: '', playlists: [], localTracks: [] } },
    })
    await flushPromises()

    expect(adminApiMock.checkUpdate).toHaveBeenCalledWith(
      '0.1.0',
      undefined,
      false,
      expect.any(AbortSignal),
      { markUnauthenticated: false },
    )

    wrapper.unmount()
  })
})
