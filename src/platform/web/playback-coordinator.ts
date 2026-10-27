import { safeStorage } from './storage'

const OWNER_KEY = 'meliora:playback-owner:v1'
export interface PlaybackOwner {
  version: 1
  id: string
  revision: number
}
function parseOwner(value: unknown): PlaybackOwner | null {
  try {
    const candidate: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (!candidate || typeof candidate !== 'object') return null
    const owner = candidate as Partial<PlaybackOwner>
    return owner.version === 1 &&
      typeof owner.id === 'string' &&
      owner.id.length > 0 &&
      owner.id.length <= 128 &&
      Number.isSafeInteger(owner.revision) &&
      owner.revision! >= 0 &&
      owner.revision! < Number.MAX_SAFE_INTEGER - 1
      ? (owner as PlaybackOwner)
      : null
  } catch {
    return null
  }
}
function newer(a: PlaybackOwner, b: PlaybackOwner | null): boolean {
  return !b || a.revision > b.revision || (a.revision === b.revision && a.id > b.id)
}

/** Claims are synchronous so HTMLMediaElement.play keeps the user's activation. */
export function createPlaybackCoordinator(options: { onLost: () => void; onClaim?: () => void }) {
  const id =
    typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`
  let owner = parseOwner(safeStorage.getItem(OWNER_KEY))
  let blocked = !!owner
  let claimed = false
  let disposed = false
  let enabled = true
  let bus: BroadcastChannel | null = null
  function receive(value: unknown): void {
    const incoming = parseOwner(value)
    if (!enabled || !incoming || disposed || !newer(incoming, owner)) return
    owner = incoming
    if (incoming.id === id) return
    blocked = true
    const lost = claimed
    claimed = false
    if (lost) options.onLost()
  }
  try {
    if (typeof window.BroadcastChannel === 'function') {
      bus = new window.BroadcastChannel(OWNER_KEY)
      bus.onmessage = (event: MessageEvent<unknown>) => receive(event.data)
    }
  } catch {
    /* Storage events still coordinate tabs if BroadcastChannel is unavailable. */
  }
  const storageChanged = (event: StorageEvent): void => {
    if (event.key === OWNER_KEY) receive(event.newValue)
  }
  window.addEventListener('storage', storageChanged)
  function owns(): boolean {
    return !disposed && (!enabled || (claimed && owner?.id === id))
  }
  function release(): void {
    const stored = parseOwner(safeStorage.getItem(OWNER_KEY))
    if (stored?.id === id) safeStorage.removeItem(OWNER_KEY)
    claimed = false
    blocked = true
  }
  return {
    owns,
    observeOwner: receive,
    owner: () => (enabled ? owner : null),
    setEnabled(value: boolean): void {
      if (enabled === value || disposed) return
      if (!value) release()
      enabled = value
      if (value) {
        owner = parseOwner(safeStorage.getItem(OWNER_KEY))
        claimed = false
        blocked = !!owner
      }
    },
    canPersist(): boolean {
      if (disposed) return false
      if (!enabled) return true
      const stored = parseOwner(safeStorage.getItem(OWNER_KEY))
      if (stored && newer(stored, owner)) receive(stored)
      return owns() || !blocked
    },
    claim(): void {
      if (disposed || !enabled) return
      const stored = parseOwner(safeStorage.getItem(OWNER_KEY))
      if (stored && newer(stored, owner)) receive(stored)
      if (owns()) return
      owner = {
        version: 1,
        id,
        revision: Math.max(owner?.revision ?? 0, stored?.revision ?? 0, Date.now()) + 1,
      }
      claimed = true
      blocked = false
      safeStorage.setItem(OWNER_KEY, JSON.stringify(owner))
      try {
        bus?.postMessage(owner)
      } catch {
        /* Storage events remain available. */
      }
      options.onClaim?.()
    },
    release,
    dispose(): void {
      release()
      disposed = true
      window.removeEventListener('storage', storageChanged)
      if (bus) bus.onmessage = null
      bus?.close()
    },
  }
}
