import { afterEach, describe, expect, it, vi } from 'vitest'
import { useUpdateStatus } from '../admin/composables/useUpdateStatus'

const adminApiMock = vi.hoisted(() => ({
  triggerUpdate: vi.fn(),
  fetchUpdateStatus: vi.fn(),
}))

vi.mock('../admin/services/admin-api', () => ({
  triggerUpdate: adminApiMock.triggerUpdate,
  fetchUpdateStatus: adminApiMock.fetchUpdateStatus,
}))

function flushPromises() {
  return Promise.resolve()
}

function runningStatusData() {
  return {
    ok: true,
    run: {
      id: 1,
      runNumber: 2,
      runAttempt: 1,
      event: 'workflow_dispatch',
      branch: 'main',
      status: 'in_progress',
      conclusion: null,
      displayStatus: 'running' as const,
      createdAt: '2026-07-02T00:00:01.000Z',
      updatedAt: '2026-07-02T00:00:02.000Z',
      htmlUrl: 'https://github.com/owner/repo/actions/runs/1',
    },
    message: 'running',
  }
}

describe('useUpdateStatus', () => {
  afterEach(() => {
    useUpdateStatus().resetUpdateStatus()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('starts polling after a successful trigger', async () => {
    adminApiMock.triggerUpdate.mockResolvedValue({
      ok: true,
      message: 'triggered',
      triggeredAt: '2026-07-02T00:00:00.000Z',
      triggerId: 'trigger-1',
    })
    adminApiMock.fetchUpdateStatus.mockResolvedValue({ ok: true, data: runningStatusData() })

    const { updateRunState, updateMessage, startUpdate } = useUpdateStatus()
    const ok = await startUpdate({
      githubProxy: '',
      targetTag: 'v0.2.0',
      receivePrereleaseUpdates: false,
    })

    expect(ok).toBe(true)
    expect(adminApiMock.triggerUpdate).toHaveBeenCalledWith('', 'v0.2.0', false)
    expect(adminApiMock.fetchUpdateStatus).toHaveBeenCalledWith(
      '2026-07-02T00:00:00.000Z',
      'trigger-1',
      expect.any(AbortSignal),
    )
    await flushPromises()
    expect(updateRunState.value).toBe('running')
    expect(updateMessage.value).toBe('running')
  })

  it('surfaces trigger failures without polling', async () => {
    adminApiMock.triggerUpdate.mockResolvedValue({ ok: false, error: '触发过于频繁' })

    const { updateRunState, updateMessage, startUpdate } = useUpdateStatus()
    const ok = await startUpdate({
      githubProxy: '',
      targetTag: 'v0.2.0',
      receivePrereleaseUpdates: false,
    })

    expect(ok).toBe(false)
    expect(updateRunState.value).toBe('error')
    expect(updateMessage.value).toBe('触发过于频繁')
    expect(adminApiMock.fetchUpdateStatus).not.toHaveBeenCalled()
  })

  it('marks the run as error after three consecutive status failures', async () => {
    vi.useFakeTimers()
    adminApiMock.triggerUpdate.mockResolvedValue({
      ok: true,
      triggeredAt: '2026-07-02T00:00:00.000Z',
      triggerId: 'trigger-1',
    })
    adminApiMock.fetchUpdateStatus.mockResolvedValue({ ok: false, error: '网络错误' })

    const { updateRunState, updateMessage, startUpdate } = useUpdateStatus()
    await startUpdate({ receivePrereleaseUpdates: false })
    await flushPromises()
    expect(updateRunState.value).toBe('locating')

    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(5000)

    expect(updateRunState.value).toBe('error')
    expect(updateMessage.value).toBe('网络错误')
    expect(adminApiMock.fetchUpdateStatus).toHaveBeenCalledTimes(3)
  })

  it('resumes polling on remount without duplicating an active schedule', async () => {
    vi.useFakeTimers()
    adminApiMock.triggerUpdate.mockResolvedValue({
      ok: true,
      triggeredAt: '2026-07-02T00:00:00.000Z',
      triggerId: 'trigger-1',
    })
    adminApiMock.fetchUpdateStatus.mockResolvedValue({ ok: true, data: runningStatusData() })

    const { resumeUpdatePolling, startUpdate } = useUpdateStatus()

    // 没有触发记录时,resume 不应发起任何请求
    resumeUpdatePolling()
    expect(adminApiMock.fetchUpdateStatus).not.toHaveBeenCalled()

    await startUpdate({ receivePrereleaseUpdates: false })
    await flushPromises()
    expect(adminApiMock.fetchUpdateStatus).toHaveBeenCalledTimes(1)

    // running 状态已排定下一次轮询(模块级 timer 仍在),remount 触发的 resume 不应重复请求
    resumeUpdatePolling()
    await flushPromises()
    expect(adminApiMock.fetchUpdateStatus).toHaveBeenCalledTimes(1)

    // 排定的轮询仍按时继续
    await vi.advanceTimersByTimeAsync(5000)
    expect(adminApiMock.fetchUpdateStatus).toHaveBeenCalledTimes(2)
  })
})
