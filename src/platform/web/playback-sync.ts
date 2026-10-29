import type { Track } from '../../core/types'
import type { createPlaybackCoordinator, PlaybackOwner } from './playback-coordinator'
import { safeStorage } from './storage'

const KEY = 'meliora:playback-sync:v1'
const LEASE_MS = 6000
const RESYNC_GRACE_MS = 2000
export interface TabPlaybackSnapshot {
  track: Track
  position: number
  duration: number
  playing: boolean
  advancing: boolean
  playbackRate: number
  seeking: boolean
}
export type TabPlaybackCommand =
  | { action: 'play' | 'pause' | 'next' | 'previous' }
  | { action: 'seek'; position: number }
  | { action: 'select'; trackId: string; queueIds?: string[] }

function finite(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}
function shortString(value: unknown, max = 2048): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}
function snapshot(value: unknown): TabPlaybackSnapshot | null {
  const data = record(value)
  const track = record(data?.track)
  if (
    !data ||
    !track ||
    !shortString(track.id) ||
    !shortString(track.title) ||
    typeof track.artist !== 'string' ||
    track.artist.length > 2048 ||
    !shortString(track.audioUrl, 8192) ||
    !['local', 'remote', 'meting'].includes(String(track.kind)) ||
    !finite(data.position, 604800) ||
    !finite(data.duration, 604800) ||
    !finite(data.playbackRate, 16) ||
    data.playbackRate === 0 ||
    typeof data.playing !== 'boolean' ||
    typeof data.advancing !== 'boolean' ||
    typeof data.seeking !== 'boolean'
  )
    return null
  try {
    if (
      !['http:', 'https:', 'blob:'].includes(new URL(track.audioUrl, window.location.href).protocol)
    )
      return null
  } catch {
    return null
  }
  // Keep the wire payload small and never forward arbitrary properties into the store.
  return {
    track: {
      id: track.id,
      title: track.title,
      artist: track.artist,
      audioUrl: track.audioUrl,
      kind: track.kind as Track['kind'],
      ...(shortString(track.cover, 8192) ? { cover: track.cover } : {}),
      ...(shortString(track.album) ? { album: track.album } : {}),
    },
    position: data.position,
    duration: data.duration,
    playbackRate: data.playbackRate,
    playing: data.playing,
    advancing: data.advancing,
    seeking: data.seeking,
  }
}
function command(value: unknown): TabPlaybackCommand | null {
  const data = record(value)
  if (!data) return null
  if (
    data.action === 'play' ||
    data.action === 'pause' ||
    data.action === 'next' ||
    data.action === 'previous'
  )
    return { action: data.action }
  if (data.action === 'seek' && finite(data.position, 604800))
    return { action: 'seek', position: data.position }
  if (data.action === 'select' && shortString(data.trackId)) {
    if (
      data.queueIds !== undefined &&
      (!Array.isArray(data.queueIds) ||
        data.queueIds.length > 10000 ||
        !data.queueIds.every((id) => shortString(id)))
    )
      return null
    return {
      action: 'select',
      trackId: data.trackId,
      queueIds: data.queueIds as string[] | undefined,
    }
  }
  return null
}
function sameOwner(a: PlaybackOwner | null, b: unknown): boolean {
  const other = record(b)
  return !!a && a.id === other?.id && a.revision === other.revision
}

/** A single audio owner publishes anchors; followers interpolate without loading audio. */
export function createPlaybackSync(options: {
  coordinator: ReturnType<typeof createPlaybackCoordinator>
  getSnapshot: () => TabPlaybackSnapshot | null
  onSnapshot: (state: TabPlaybackSnapshot) => void
  onTick: (state: TabPlaybackSnapshot) => void
  onStop: (state: TabPlaybackSnapshot) => void
  onCommand: (command: TabPlaybackCommand) => void | Promise<void>
}) {
  const sender =
    typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`
  let sequence = 0
  let enabled = false
  let disposed = false
  let bus: BroadcastChannel | null = null
  let timer: number | undefined
  let lastPublish = -Infinity
  let lastRequest = -Infinity
  let remote: {
    state: TabPlaybackSnapshot
    receivedAt: number
    ageAtReceipt: number
    owner: PlaybackOwner
  } | null = null
  let resyncUntil = 0
  let lastTick = 0
  const pendingCommands: Array<{ owner: PlaybackOwner; action: TabPlaybackCommand }> = []
  const seen = new Map<string, number>()
  const remoteAge = (): number =>
    remote ? remote.ageAtReceipt + Math.max(0, performance.now() - remote.receivedAt) : Infinity

  function read(): TabPlaybackSnapshot | null {
    if (!remote) return null
    const state = remote.state
    const elapsed = Math.min(LEASE_MS, remoteAge()) / 1000
    const position =
      state.position + (state.advancing && !state.seeking ? elapsed * state.playbackRate : 0)
    return {
      ...state,
      position: state.duration > 0 ? Math.min(position, state.duration) : position,
      advancing: state.advancing && remoteAge() <= LEASE_MS,
    }
  }
  function stopFollowing(): void {
    const state = read()
    remote = null
    resyncUntil = 0
    pendingCommands.length = 0
    if (state) options.onStop({ ...state, playing: false, advancing: false })
  }
  function send(kind: string, payload: object = {}): void {
    if (!enabled || disposed) return
    const message = { version: 1, kind, sender, sequence: ++sequence, at: Date.now(), ...payload }
    try {
      if (bus) {
        bus.postMessage(message)
        return
      }
    } catch {
      /* A restricted browser can still deliver storage events. */
    }
    safeStorage.setItem(KEY, JSON.stringify(message))
  }
  function publish(force = false): void {
    if (!enabled || !options.coordinator.owns() || disposed) return
    if (!force && performance.now() - lastPublish < 1000) return
    const state = snapshot(options.getSnapshot())
    if (!state) return
    lastPublish = performance.now()
    send('state', { owner: options.coordinator.owner(), state })
  }
  function receive(value: unknown): void {
    const message = record(value)
    if (
      !enabled ||
      disposed ||
      !message ||
      message.version !== 1 ||
      message.sender === sender ||
      !shortString(message.sender, 128) ||
      !Number.isSafeInteger(message.sequence) ||
      (message.sequence as number) <= (seen.get(message.sender) ?? 0) ||
      !finite(message.at, Number.MAX_SAFE_INTEGER) ||
      Math.abs(Date.now() - message.at) > LEASE_MS
    )
      return
    seen.delete(message.sender)
    seen.set(message.sender, message.sequence as number)
    if (seen.size > 32) seen.delete(seen.keys().next().value!)
    if (message.kind === 'request') {
      publish(true)
    } else if (message.kind === 'state') {
      const state = snapshot(message.state)
      if (!state) return
      options.coordinator.observeOwner(message.owner)
      if (options.coordinator.owns() || !sameOwner(options.coordinator.owner(), message.owner))
        return
      remote = {
        state,
        receivedAt: performance.now(),
        ageAtReceipt: Math.max(0, Date.now() - message.at),
        owner: options.coordinator.owner()!,
      }
      resyncUntil = 0
      options.onSnapshot(read()!)
      if (!enabled || !remote) return
      for (const pending of pendingCommands.splice(0)) {
        if (sameOwner(remote.owner, pending.owner))
          send('command', { owner: remote.owner, command: pending.action })
      }
    } else if (message.kind === 'command') {
      const action = command(message.command)
      if (
        !action ||
        !options.coordinator.owns() ||
        !sameOwner(options.coordinator.owner(), message.owner)
      )
        return
      void Promise.resolve()
        .then(() => {
          if (
            enabled &&
            !disposed &&
            options.coordinator.owns() &&
            sameOwner(options.coordinator.owner(), message.owner)
          )
            return options.onCommand(action)
        })
        .catch(() => {
          // The player exposes playback failures in its own state; never leave a rejected bus task.
        })
        .finally(() => publish(true))
    } else if (message.kind === 'release' && remote && sameOwner(remote.owner, message.owner)) {
      const state = snapshot(message.state)
      if (state)
        remote = {
          state,
          receivedAt: performance.now(),
          ageAtReceipt: Math.max(0, Date.now() - message.at),
          owner: remote.owner,
        }
      stopFollowing()
    }
  }
  const storage = (event: StorageEvent): void => {
    if (event.key !== KEY || !event.newValue) return
    try {
      receive(JSON.parse(event.newValue))
    } catch {
      /* Ignore malformed messages. */
    }
  }
  function request(): void {
    lastRequest = performance.now()
    send('request')
  }
  function probe(): void {
    if (resyncUntil) return
    resyncUntil = performance.now() + RESYNC_GRACE_MS
    request()
  }
  function schedule(): void {
    if (timer !== undefined) window.clearTimeout(timer)
    if (!enabled || disposed) return
    timer = window.setTimeout(
      tick,
      options.coordinator.owns() ? 1000 : document.hidden ? 2000 : 250,
    )
  }
  function tick(): void {
    timer = undefined
    if (!enabled || disposed) return
    const now = performance.now()
    // A delayed callback after sleep says nothing about whether the audio owner died.
    if (remote && now - lastTick > LEASE_MS) probe()
    lastTick = now
    if (options.coordinator.owns()) {
      // An explicit local play takes ownership synchronously before its first state update.
      remote = null
      resyncUntil = 0
      pendingCommands.length = 0
      publish()
    } else if (
      remote &&
      remoteAge() <= LEASE_MS &&
      sameOwner(options.coordinator.owner(), remote.owner)
    ) {
      if (!document.hidden) options.onTick(read()!)
    } else if (
      remote &&
      sameOwner(options.coordinator.owner(), remote.owner) &&
      (!resyncUntil || now < resyncUntil)
    ) {
      probe()
    } else {
      stopFollowing()
      if (performance.now() - lastRequest >= 2000) request()
    }
    schedule()
  }
  function wake(): void {
    if (!enabled || disposed) return
    lastTick = performance.now()
    if (options.coordinator.owns()) publish(true)
    else if (!document.hidden) {
      resyncUntil = 0
      probe()
    }
    schedule()
  }
  function release(): void {
    if (options.coordinator.owns())
      send('release', {
        owner: options.coordinator.owner(),
        state: snapshot(options.getSnapshot()),
      })
  }
  function setEnabled(value: boolean): void {
    if (enabled === value || disposed) return
    if (!value) {
      release()
      enabled = false
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
      window.removeEventListener('storage', storage)
      window.removeEventListener('pageshow', wake)
      document.removeEventListener('visibilitychange', wake)
      bus?.close()
      bus = null
      seen.clear()
      stopFollowing()
      return
    }
    enabled = true
    try {
      if (typeof window.BroadcastChannel === 'function') {
        bus = new window.BroadcastChannel(KEY)
        bus.onmessage = (event: MessageEvent<unknown>) => receive(event.data)
      }
    } catch {
      /* Storage is the fallback transport. */
    }
    window.addEventListener('storage', storage)
    window.addEventListener('pageshow', wake)
    document.addEventListener('visibilitychange', wake)
    lastTick = performance.now()
    schedule()
    publish(true)
    request()
  }
  return {
    read,
    publish,
    release,
    setEnabled,
    command(action: TabPlaybackCommand): boolean {
      if (!enabled || options.coordinator.owns()) return false
      if (
        remote &&
        sameOwner(options.coordinator.owner(), remote.owner) &&
        remoteAge() > LEASE_MS &&
        (!resyncUntil || performance.now() < resyncUntil)
      ) {
        // Keep a wake-up click remote until the owner answers; never start a second audio stream.
        if (pendingCommands.length >= 16) pendingCommands.shift()
        pendingCommands.push({ owner: remote.owner, action })
        probe()
        return true
      }
      if (
        !remote ||
        remoteAge() > LEASE_MS ||
        !sameOwner(options.coordinator.owner(), remote.owner)
      ) {
        stopFollowing()
        return false
      }
      send('command', { owner: remote.owner, command: action })
      return true
    },
    dispose(): void {
      setEnabled(false)
      disposed = true
    },
  }
}
