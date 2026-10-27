import { readonly, shallowRef } from 'vue'
import {
  BEAT_THIS_FILTERBANK,
  BEAT_THIS_MODELS,
  type BeatThisModelId,
} from '../../core/analysis/beat-this-models'
import { BEAT_THIS_RUNTIME } from '../../generated/beat-this-runtime'
import { createBeatThisAssetStore } from './beat-this-cache'
import { invalidateBeatModelSessions } from './beat-worker-pool'

export interface BeatThisModelStatus {
  phase: 'checking' | 'missing' | 'downloading' | 'removing' | 'ready' | 'error'
  progress: number
  error: string | null
}
const initial = (): BeatThisModelStatus => ({ phase: 'checking', progress: 0, error: null })
const status = shallowRef<Record<BeatThisModelId, BeatThisModelStatus>>({
  small: initial(),
  standard: initial(),
})
let initialized: Promise<void> | null = null
let removalJob: Promise<void> | null = null
let currentDownload: {
  id: BeatThisModelId
  controller: AbortController
  done: Promise<boolean>
} | null = null
const revisions = { small: 0, standard: 0 }
const savedProgress = { small: 0, standard: 0 }
const runtime = (): ReturnType<typeof createBeatThisAssetStore> =>
  createBeatThisAssetStore(BEAT_THIS_RUNTIME)
const stores = new Map<BeatThisModelId, ReturnType<typeof createBeatThisAssetStore>>()
let runtimeStore: ReturnType<typeof createBeatThisAssetStore> | null = null
function sharedRuntime(): ReturnType<typeof createBeatThisAssetStore> {
  return (runtimeStore ??= runtime())
}
function store(id: BeatThisModelId): ReturnType<typeof createBeatThisAssetStore> {
  let entry = stores.get(id)
  if (!entry) {
    entry = createBeatThisAssetStore({
      version: BEAT_THIS_MODELS[id].version,
      parts: [...BEAT_THIS_MODELS[id].parts, BEAT_THIS_FILTERBANK],
    })
    stores.set(id, entry)
  }
  return entry
}
function update(id: BeatThisModelId, value: BeatThisModelStatus): void {
  status.value = { ...status.value, [id]: value }
}
async function initialize(): Promise<void> {
  if (initialized) return initialized
  initialized = (async () => {
    const versions = { ...revisions }
    const runtimeReady = await sharedRuntime().has()
    const runtimeSaved = runtimeReady ? 0 : await sharedRuntime().savedBytes()
    await Promise.all(
      (['small', 'standard'] as const).map(async (id) => {
        const modelReady = await store(id).has()
        const cached = runtimeReady && modelReady
        const modelBytes = BEAT_THIS_MODELS[id].parts.reduce(
          (sum, part) => sum + part.bytes,
          BEAT_THIS_FILTERBANK.bytes,
        )
        const modelSaved = modelReady ? modelBytes : await store(id).savedBytes()
        // A shared runtime by itself does not imply this model has a partial download.
        const progress = modelSaved
          ? (modelSaved + runtimeSaved) /
            (modelBytes + (runtimeReady ? 0 : BEAT_THIS_RUNTIME.bytes))
          : 0
        if (revisions[id] === versions[id]) {
          savedProgress[id] = progress
          update(id, {
            phase: cached ? 'ready' : 'missing',
            progress: cached ? 1 : progress,
            error: null,
          })
        }
      }),
    )
  })().catch(() => {
    for (const id of ['small', 'standard'] as const)
      if (status.value[id].phase === 'checking')
        update(id, { phase: 'missing', progress: 0, error: null })
  })
  return initialized
}
function cancel(id: BeatThisModelId): void {
  if (currentDownload?.id !== id) return
  currentDownload.controller.abort()
  update(id, { phase: 'missing', progress: savedProgress[id], error: null })
}
function finishDownload(controller: AbortController): void {
  if (currentDownload?.controller === controller) currentDownload = null
}
async function download(id: BeatThisModelId): Promise<boolean> {
  await initialize()
  // Recheck after every await: deletion can remove the shared runtime and multiple
  // retry clicks may all be waiting for the same cancelled download to finish.
  for (;;) {
    if (removalJob) {
      await removalJob
      continue
    }
    if (!currentDownload) break
    if (!currentDownload.controller.signal.aborted)
      return currentDownload.id === id ? currentDownload.done : false
    await currentDownload.done
  }
  if (status.value[id].phase === 'removing') return false
  if (status.value[id].phase === 'ready') return true
  const version = ++revisions[id]
  const controller = new AbortController()
  const active = (): boolean => revisions[id] === version && !controller.signal.aborted
  update(id, { phase: 'downloading', progress: savedProgress[id], error: null })
  const done = (async (): Promise<boolean> => {
    try {
      const runtimeReady = await sharedRuntime().has()
      const runtimeSaved = runtimeReady ? 0 : await sharedRuntime().savedBytes()
      const modelBytes = BEAT_THIS_MODELS[id].parts.reduce(
        (sum, part) => sum + part.bytes,
        BEAT_THIS_FILTERBANK.bytes,
      )
      const total = modelBytes + (runtimeReady ? 0 : BEAT_THIS_RUNTIME.bytes)
      const report = (bytes: number, savedBytes = bytes): void => {
        if (revisions[id] === version) savedProgress[id] = savedBytes / total
        if (active()) update(id, { phase: 'downloading', progress: bytes / total, error: null })
      }
      await store(id).download(controller.signal, (bytes, savedBytes = bytes) =>
        report(bytes + runtimeSaved, savedBytes + runtimeSaved),
      )
      if (!runtimeReady)
        await sharedRuntime().download(controller.signal, (bytes, savedBytes = bytes) =>
          report(modelBytes + bytes, modelBytes + savedBytes),
        )
      controller.signal.throwIfAborted()
      if (!active()) return false
      update(id, { phase: 'ready', progress: 1, error: null })
      return true
    } catch (error) {
      if (controller.signal.aborted && revisions[id] === version)
        update(id, { phase: 'missing', progress: savedProgress[id], error: null })
      if (active())
        update(id, {
          phase: 'error',
          progress: savedProgress[id],
          error:
            error instanceof Error && /[\u3400-\u9fff]/.test(error.message)
              ? error.message
              : '模型下载失败，请检查网络后重试',
        })
      return false
    } finally {
      finishDownload(controller)
    }
  })()
  currentDownload = { id, controller, done }
  return done
}
async function remove(id: BeatThisModelId): Promise<void> {
  await initialize()
  if (status.value[id].phase === 'removing') return
  const pending = currentDownload?.id === id ? currentDownload : null
  cancel(id)
  revisions[id] += 1
  update(id, { phase: 'removing', progress: 0, error: null })
  invalidateBeatModelSessions(id)
  const previousRemoval = removalJob
  const job = (async (): Promise<void> => {
    await previousRemoval
    if (pending) await pending.done
    try {
      await store(id).clear()
      savedProgress[id] = 0
      const other = id === 'small' ? 'standard' : 'small'
      if (!currentDownload && !(await store(other).has())) await sharedRuntime().clear()
      update(id, { phase: 'missing', progress: 0, error: null })
    } catch {
      update(id, { phase: 'error', progress: 0, error: '模型缓存未能删除，请重试' })
    }
  })()
  removalJob = job
  try {
    await job
  } finally {
    if (removalJob === job) removalJob = null
  }
}
export async function readBeatThisModel(id: BeatThisModelId, signal: AbortSignal) {
  await initialize()
  signal.throwIfAborted()
  if (status.value[id].phase !== 'ready') throw new Error('请先在设置中下载并启用此模型')
  try {
    const combined = await store(id).read(signal)
    const wasmBinary = await sharedRuntime().read(signal)
    signal.throwIfAborted()
    if (!combined || !wasmBinary) throw new Error('模型缓存已被浏览器清理，请重新下载')
    const bytes = combined.byteLength - BEAT_THIS_FILTERBANK.bytes
    return {
      model: combined.slice(0, bytes),
      filterbank: combined.slice(bytes),
      wasmBinary,
      wasmPaths: { mjs: new URL(BEAT_THIS_RUNTIME.mjs, window.location.href).href },
    }
  } catch (error) {
    if (!signal.aborted)
      update(id, { phase: 'error', progress: 0, error: '模型缓存无法读取，请重试下载修复' })
    throw error
  }
}
export function useBeatThisModels() {
  return {
    status: readonly(status),
    initialize,
    download,
    cancel,
    remove,
    async savedBytes(): Promise<{ small: number; standard: number; runtime: number }> {
      const [small, standard, runtime] = await Promise.all([
        store('small').savedBytes(),
        store('standard').savedBytes(),
        sharedRuntime().savedBytes(),
      ])
      return { small, standard, runtime }
    },
    runtimeBytes: BEAT_THIS_RUNTIME.bytes,
  }
}
