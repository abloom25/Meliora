/** Keep word timing on the ink layer; a static, inaccessible copy owns the resting appearance. */
export interface LyricBrightness {
  readonly original: HTMLElement
  sync: () => void
  setActive: (active: boolean) => void
  dispose: () => void
}

export const LYRIC_BRIGHTNESS_SETTLE_MS = 460

export function createLyricBrightness(line: HTMLElement): LyricBrightness | null {
  const original = line.querySelector<HTMLElement>('.lyric-original')
  if (!original) return null
  const main: HTMLElement = original
  let copy: HTMLElement | null = null
  let dirty = true
  let active = false
  let disposed = false
  let entrance: Animation[] = []
  const Observer = main.ownerDocument.defaultView?.MutationObserver
  const observer = !Observer
    ? null
    : new Observer(() => {
        dirty = true
      })
  observer?.observe(main, { childList: true, subtree: true, characterData: true })

  function cancelEntrance(): void {
    for (const animation of entrance) animation.cancel()
    entrance = []
  }

  function sync(): void {
    if (disposed) return
    if (observer?.takeRecords().length) dirty = true
    if (!dirty && copy?.isConnected) return
    cancelEntrance()
    const next = main.cloneNode(true) as HTMLElement
    next.classList.replace('lyric-original', 'lyric-original-dim')
    next.setAttribute('aria-hidden', 'true')
    next.inert = true
    for (const node of [next, ...next.querySelectorAll<HTMLElement>('*')]) {
      node.removeAttribute('style')
      node.removeAttribute('id')
      node.removeAttribute('data-lyric-sweep')
      if (node.classList.replace('lyric-word', 'lyric-dim-word')) node.classList.remove('word')
      node.classList.replace('lyric-char', 'lyric-dim-char')
      if (node.classList.replace('lyric-gap', 'lyric-dim-gap')) node.classList.remove('gap')
    }
    if (copy) copy.replaceWith(next)
    else main.after(next)
    copy = next
    line.dataset.lyricLayered = ''
    dirty = false
  }

  sync()
  return {
    original: main,
    sync,
    setActive(next) {
      if (disposed || active === next) return
      const entering = !line.hasAttribute('data-lyric-visited')
      active = next
      cancelEntrance()
      line.toggleAttribute('data-lyric-bright', active)
      if (active) line.dataset.lyricVisited = ''
      // A newly mounted line has no previous CSS opacity to interpolate from.
      if (
        active &&
        entering &&
        !line.classList.contains('background') &&
        typeof main.animate === 'function' &&
        copy
      ) {
        const options = { duration: 300, easing: 'cubic-bezier(.16,1,.3,1)' }
        entrance = [
          main.animate([{ opacity: 0 }, { opacity: 1 }], options),
          copy.animate([{ opacity: 1 }, { opacity: 0 }], options),
        ]
        for (const animation of entrance)
          animation.onfinish = () => {
            animation.cancel()
          }
      }
    },
    dispose() {
      disposed = true
      cancelEntrance()
      observer?.disconnect()
      copy?.remove()
      copy = null
      for (const name of ['data-lyric-layered', 'data-lyric-bright', 'data-lyric-visited'])
        line.removeAttribute(name)
    },
  }
}
