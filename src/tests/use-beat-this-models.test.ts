import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

const createStore = vi.hoisted(() => vi.fn())
vi.mock('../platform/web/beat-this-cache', () => ({ createBeatThisAssetStore: createStore }))
vi.mock('../core/analysis/beat-this-models', () => ({
  BEAT_THIS_FILTERBANK: { url: '/filterbank.bin', bytes: 2, sha256: 'test-filterbank' },
  BEAT_THIS_MODELS: {
    small: {
      id: 'small',
      label: 'Beat This! Small',
      version: 'test-small',
      downloadBytes: 6,
      parts: [{ url: '/small.bin', bytes: 4, sha256: 'test-small' }],
    },
    standard: {
      id: 'standard',
      label: 'Beat This! 标准版',
      version: 'test-standard',
      downloadBytes: 10,
      parts: [{ url: '/standard.bin', bytes: 8, sha256: 'test-standard' }],
    },
  },
}))
vi.mock('../generated/beat-this-runtime', () => ({
  BEAT_THIS_RUNTIME: {
    version: 'test-runtime',
    bytes: 3,
    parts: [{ url: '/runtime.bin', bytes: 3, sha256: 'test-runtime' }],
    mjs: '/runtime.mjs',
  },
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

function fakeStore(bytes: number) {
  const state = {
    cached: false,
    saved: 0,
    downloadGate: null as ReturnType<typeof deferred> | null,
    clearGate: null as ReturnType<typeof deferred> | null,
  }
  const has = vi.fn(async () => state.cached)
  const savedBytes = vi.fn(async () => (state.cached ? bytes : state.saved))
  const read = vi.fn(async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    return state.cached ? new ArrayBuffer(bytes) : null
  })
  const download = vi.fn(async (signal: AbortSignal, report: (bytes: number) => void) => {
    signal.throwIfAborted()
    report(bytes / 2)
    if (state.downloadGate) {
      const gate = state.downloadGate
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        void gate.promise.then(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        })
      })
    }
    signal.throwIfAborted()
    state.cached = true
    report(bytes)
  })
  const clear = vi.fn(async () => {
    if (state.clearGate) await state.clearGate.promise
    state.cached = false
    state.saved = 0
  })
  return { state, has, savedBytes, read, download, clear }
}

let small: ReturnType<typeof fakeStore>
let standard: ReturnType<typeof fakeStore>
let runtime: ReturnType<typeof fakeStore>

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  small = fakeStore(6)
  standard = fakeStore(10)
  runtime = fakeStore(3)
  createStore.mockImplementation(({ version }: { version: string }) => {
    if (version === 'test-small') return small
    if (version === 'test-standard') return standard
    if (version === 'test-runtime') return runtime
    throw new Error(`Unexpected fixture version: ${version}`)
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Unexpected network request'))),
  )
})

afterEach(() => vi.unstubAllGlobals())

async function manager() {
  const module = await import('../platform/web/useBeatThisModels')
  return { ...module.useBeatThisModels(), read: module.readBeatThisModel, module }
}

describe('optional Beat This model manager', () => {
  it('inventories completed and partial downloads without counting the shared runtime twice', async () => {
    small.state.cached = true
    standard.state.saved = 4
    runtime.state.cached = true
    const models = await manager()
    expect(await models.module.useBeatThisModels().savedBytes()).toEqual({
      small: 6,
      standard: 4,
      runtime: 3,
    })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('restores partial progress after reopening without implicit network requests', async () => {
    small.state.saved = 3
    runtime.state.saved = 1
    const models = await manager()
    await models.initialize()
    expect(models.status.value.small).toEqual({ phase: 'missing', progress: 4 / 9, error: null })
    expect(models.status.value.standard.progress).toBe(0)
    expect(small.download).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    await models.remove('small')
    expect(small.state.saved).toBe(0)
    expect(runtime.state.saved).toBe(0)
    expect(models.status.value.small.progress).toBe(0)
  })
  it('keeps saved runtime parts in resumed progress while downloading the model', async () => {
    small.state.saved = 3
    runtime.state.saved = 1
    small.state.downloadGate = deferred()
    const models = await manager()
    await models.initialize()
    const pending = models.download('small')
    await vi.waitFor(() => expect(small.download).toHaveBeenCalledOnce())
    expect(models.status.value.small.progress).toBeCloseTo(4 / 9)
    small.state.downloadGate.resolve()
    expect(await pending).toBe(true)
  })
  it('shares initialization and reports missing models without any download or fetch', async () => {
    const models = await manager()
    const otherView = models.module.useBeatThisModels()
    expect(otherView.status).toBe(models.status)
    await Promise.all([models.initialize(), otherView.initialize()])
    expect(models.status.value.small.phase).toBe('missing')
    expect(models.status.value.standard.phase).toBe('missing')
    expect(runtime.has).toHaveBeenCalledOnce()
    expect(small.download).not.toHaveBeenCalled()
    expect(standard.download).not.toHaveBeenCalled()
    expect(runtime.download).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads existing local assets and separates the model, filterbank and shared runtime', async () => {
    small.state.cached = true
    runtime.state.cached = true
    const models = await manager()
    await models.initialize()
    expect(models.status.value.small.phase).toBe('ready')
    expect(models.status.value.standard.phase).toBe('missing')
    const assets = await models.read('small', new AbortController().signal)
    expect(assets.model.byteLength).toBe(4)
    expect(assets.filterbank.byteLength).toBe(2)
    expect(assets.wasmBinary.byteLength).toBe(3)
    expect(assets.wasmPaths.mjs).toBe(new URL('/runtime.mjs', window.location.href).href)
    expect(small.download).not.toHaveBeenCalled()
    expect(runtime.download).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('downloads only on request, includes runtime in progress and reuses it for the other model', async () => {
    small.state.downloadGate = deferred()
    const models = await manager()
    const downloading = models.download('small')
    await vi.waitFor(() => expect(small.download).toHaveBeenCalledOnce())
    expect(models.status.value.small.phase).toBe('downloading')
    expect(models.status.value.small.progress).toBeCloseTo(3 / 9)
    expect(runtime.download).not.toHaveBeenCalled()
    small.state.downloadGate.resolve()
    expect(await downloading).toBe(true)
    expect(models.status.value.small).toEqual({ phase: 'ready', progress: 1, error: null })
    expect(runtime.download).toHaveBeenCalledOnce()
    expect(await models.download('standard')).toBe(true)
    expect(standard.download).toHaveBeenCalledOnce()
    expect(runtime.download).toHaveBeenCalledOnce()
    expect(await models.download('small')).toBe(true)
    expect(small.download).toHaveBeenCalledOnce()
  })

  it('deduplicates same-model requests and rejects concurrent downloads of another model', async () => {
    small.state.downloadGate = deferred()
    const models = await manager()
    const first = models.download('small')
    await vi.waitFor(() => expect(small.download).toHaveBeenCalledOnce())
    const same = models.download('small')
    expect(await models.download('standard')).toBe(false)
    expect(standard.download).not.toHaveBeenCalled()
    small.state.downloadGate.resolve()
    expect(await first).toBe(true)
    expect(await same).toBe(true)
    expect(small.download).toHaveBeenCalledOnce()
  })

  it('cancels a download, preserves saved progress and permits an explicit retry', async () => {
    small.state.downloadGate = deferred()
    const models = await manager()
    const downloading = models.download('small')
    await vi.waitFor(() => expect(small.download).toHaveBeenCalledOnce())
    models.cancel('small')
    expect(await downloading).toBe(false)
    expect(models.status.value.small).toEqual({ phase: 'missing', progress: 3 / 9, error: null })
    expect(small.state.cached).toBe(false)
    expect(small.clear).not.toHaveBeenCalled()
    expect(runtime.download).not.toHaveBeenCalled()
    small.state.downloadGate = null
    expect(await models.download('small')).toBe(true)
    expect(small.download).toHaveBeenCalledTimes(2)
  })

  it('waits for cancelled in-flight writes before retrying and coalesces retry clicks', async () => {
    const gate = deferred()
    small.download.mockImplementationOnce(async (signal, report) => {
      report(3)
      await gate.promise
      signal.throwIfAborted()
    })
    const models = await manager()
    const oldDownload = models.download('small')
    await vi.waitFor(() => expect(small.download).toHaveBeenCalledOnce())
    models.cancel('small')
    const firstRetry = models.download('small')
    const secondRetry = models.download('small')
    await flushPromises()
    expect(small.download).toHaveBeenCalledOnce()
    gate.resolve()
    expect(await oldDownload).toBe(false)
    expect(await firstRetry).toBe(true)
    expect(await secondRetry).toBe(true)
    expect(small.download).toHaveBeenCalledTimes(2)
    expect(small.clear).not.toHaveBeenCalled()
    expect(runtime.download).toHaveBeenCalledOnce()
  })

  it('preserves a completed model when runtime download fails and retries without clearing either cache', async () => {
    runtime.download.mockRejectedValueOnce(new Error('网络中断'))
    const models = await manager()
    expect(await models.download('small')).toBe(false)
    expect(models.status.value.small.phase).toBe('error')
    expect(models.status.value.small.progress).toBeCloseTo(6 / 9)
    expect(small.state.cached).toBe(true)
    expect(small.clear).not.toHaveBeenCalled()
    expect(runtime.clear).not.toHaveBeenCalled()
    expect(await models.download('small')).toBe(true)
    expect(models.status.value.small.phase).toBe('ready')
  })

  it('removes only the selected model and retains shared runtime until no model uses it', async () => {
    small.state.cached = true
    standard.state.cached = true
    runtime.state.cached = true
    const models = await manager()
    await models.remove('small')
    expect(models.status.value.small.phase).toBe('missing')
    expect(models.status.value.standard.phase).toBe('ready')
    expect(standard.clear).not.toHaveBeenCalled()
    expect(runtime.clear).not.toHaveBeenCalled()
    await models.remove('standard')
    expect(models.status.value.standard.phase).toBe('missing')
    expect(runtime.clear).toHaveBeenCalledOnce()
    expect(runtime.state.cached).toBe(false)
  })

  it('finishes removing an in-flight model without a late ready state', async () => {
    small.state.downloadGate = deferred()
    const models = await manager()
    const downloading = models.download('small')
    await vi.waitFor(() => expect(small.download).toHaveBeenCalledOnce())
    await models.remove('small')
    expect(await downloading).toBe(false)
    expect(small.state.cached).toBe(false)
    expect(models.status.value.small.phase).toBe('missing')
    expect(runtime.download).not.toHaveBeenCalled()
  })

  it('keeps the shared runtime available when downloading another model during removal', async () => {
    small.state.cached = true
    runtime.state.cached = true
    runtime.state.clearGate = deferred()
    const models = await manager()
    const removing = models.remove('small')
    await vi.waitFor(() => expect(runtime.clear).toHaveBeenCalledOnce())
    const downloading = models.download('standard')
    await flushPromises()
    runtime.state.clearGate.resolve()
    await removing
    expect(await downloading).toBe(true)
    expect(models.status.value.standard.phase).toBe('ready')
    expect(runtime.state.cached).toBe(true)
    await expect(models.read('standard', new AbortController().signal)).resolves.toBeDefined()
  })

  it('reports evicted caches without silently redownloading, then accepts a manual retry', async () => {
    small.state.cached = true
    runtime.state.cached = true
    const models = await manager()
    await models.initialize()
    small.state.cached = false
    await expect(models.read('small', new AbortController().signal)).rejects.toThrow('模型缓存')
    expect(models.status.value.small.phase).toBe('error')
    expect(small.download).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(await models.download('small')).toBe(true)
    expect(small.download).toHaveBeenCalledOnce()
  })

  it('does not corrupt model availability when a read is cancelled', async () => {
    small.state.cached = true
    runtime.state.cached = true
    const models = await manager()
    await models.initialize()
    const controller = new AbortController()
    controller.abort()
    await expect(models.read('small', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(models.status.value.small.phase).toBe('ready')
    expect(small.read).not.toHaveBeenCalled()
  })
})
