import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia, storeToRefs, type Pinia } from 'pinia'
import { defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlayerArtwork } from '../composables/usePlayerArtwork'
import { useCoverCache } from '../composables/useCoverCache'
import { usePlayerStore } from '../stores/player'
import { extractThemeColor } from '../platform/web/theme'
import type { Track } from '../core/types'

const themeActions = vi.hoisted(() => ({
  applyTheme: vi.fn(),
  resetTheme: vi.fn(),
}))
vi.mock('../platform/web/theme', () => ({ extractThemeColor: vi.fn(async () => null) }))
vi.mock('../composables/useThemeAccent', async () => {
  const { ref } = await import('vue')
  return {
    useThemeAccent: () => ({
      accent: ref(''),
      accentSoft: ref(''),
      accentRgb: ref(''),
      cssTransitionSupported: ref(false),
      ...themeActions,
    }),
  }
})

const track: Track = {
  id: 'artwork-track',
  title: 'Song',
  artist: 'Artist',
  kind: 'local',
  audioUrl: '/song.mp3',
  cover: '/artwork.jpg',
}
const wrappers: VueWrapper[] = []
let pinia: Pinia

function mountArtwork(current: Readonly<Ref<Track | null>> = ref({ ...track })) {
  const store = usePlayerStore()
  const hidden = ref(false)
  let artwork!: ReturnType<typeof usePlayerArtwork>
  const wrapper = mount(
    defineComponent({
      setup() {
        artwork = usePlayerArtwork(current, ref(store.settings))
        return () =>
          h(
            'div',
            {
              class: { loaded: artwork.mainCoverReadyTrackId.value === current.value?.id },
              style: { display: hidden.value ? 'none' : '' },
            },
            artwork.mainCoverItems.value.map((item) =>
              h('img', {
                key: item.key,
                ref: artwork.setMainCoverImage,
                src: item.cover,
                crossorigin: item.corsRetried ? undefined : 'anonymous',
                alt: item.title,
                onLoad: (event: Event) => void artwork.handleMainCoverLoaded(item.id, event),
                onError: (event: Event) =>
                  artwork.handleMainCoverError(item.id, item.corsKey, event),
              }),
            ),
          )
      },
    }),
    { attachTo: document.body },
  )
  wrappers.push(wrapper)
  return { artwork, wrapper, hidden }
}

async function flushUpdates(): Promise<void> {
  for (let step = 0; step < 5; step += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function completeImage(image: HTMLImageElement, width = 200): void {
  Object.defineProperties(image, {
    complete: { configurable: true, get: () => true },
    naturalWidth: { configurable: true, get: () => width },
    naturalHeight: { configurable: true, get: () => width },
  })
}

function loadEvent(image: HTMLImageElement): Event {
  const event = new Event('load')
  Object.defineProperty(event, 'currentTarget', { value: image })
  return event
}

async function loadImage(wrapper: VueWrapper): Promise<HTMLImageElement> {
  const image = wrapper.get<HTMLImageElement>('img')
  completeImage(image.element)
  image.element.decode = vi.fn(async () => {})
  await image.trigger('load')
  await flushUpdates()
  return image.element
}

beforeEach(() => {
  vi.clearAllMocks()
  pinia = createPinia()
  setActivePinia(pinia)
  useCoverCache().resetMainCover()
  vi.mocked(extractThemeColor).mockResolvedValue(null)
})

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  const cache = useCoverCache()
  for (const failed of cache.failedCovers.value) cache.markCoverLoaded(failed)
  cache.loadedCovers.value.clear()
  disposePinia(pinia)
  setActivePinia(undefined)
  vi.restoreAllMocks()
})

describe('player artwork readiness', () => {
  it('keeps the loaded image when a library refresh removes and restores the same cover in one batch', async () => {
    const store = usePlayerStore()
    store.setTracks([{ ...track }])
    store.selectTrack(store.tracks[0]!)
    const { currentTrack } = storeToRefs(store)
    const { artwork, wrapper } = mountArtwork(currentTrack)
    const image = await loadImage(wrapper)
    expect(wrapper.classes()).toContain('loaded')

    store.setTracks([{ ...track, title: 'Refreshed metadata' }])
    await flushUpdates()

    expect(wrapper.get('img').element).toBe(image)
    expect(image.decode).toHaveBeenCalledOnce()
    expect(artwork.mainCoverReadyTrackId.value).toBe(track.id)
    expect(wrapper.classes()).toContain('loaded')
  })

  it('preserves readiness when the track object is replaced without changing its cover identity', async () => {
    const current = ref<Track | null>({ ...track })
    const { wrapper, artwork } = mountArtwork(current)
    const image = await loadImage(wrapper)
    current.value = { ...track, title: 'Same cover' }
    await flushUpdates()

    expect(wrapper.get('img').element).toBe(image)
    expect(artwork.mainCoverReadyTrackId.value).toBe(track.id)
    expect(image.decode).toHaveBeenCalledOnce()
  })

  it('keeps the retained foreground visible after a layout hides and restores it without another load event', async () => {
    const { wrapper, hidden, artwork } = mountArtwork()
    const image = await loadImage(wrapper)
    hidden.value = true
    await flushUpdates()
    hidden.value = false
    await flushUpdates()

    expect(wrapper.get('img').element).toBe(image)
    expect(wrapper.classes()).toContain('loaded')
    expect(artwork.mainCoverReadyTrackId.value).toBe(track.id)
    expect(image.decode).toHaveBeenCalledOnce()
  })

  it('recovers an already-complete cached image when no new load event is delivered', async () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(200)
    const { wrapper, artwork } = mountArtwork()
    await flushUpdates()

    expect(artwork.mainCoverReadyTrackId.value).toBe(track.id)
    expect(wrapper.classes()).toContain('loaded')
    expect(extractThemeColor).toHaveBeenCalledOnce()
    artwork.setMainCoverImage(wrapper.get('img').element)
    await flushUpdates()
    expect(extractThemeColor).toHaveBeenCalledOnce()
  })

  it('does not borrow readiness from a cached thumbnail before the foreground is loaded', async () => {
    useCoverCache().markCoverLoaded(track.id, track.cover)
    const { wrapper, artwork } = mountArtwork()
    await flushUpdates()

    expect(wrapper.classes()).not.toContain('loaded')
    expect(artwork.mainCoverReadyTrackId.value).toBeNull()
    await loadImage(wrapper)
    expect(wrapper.classes()).toContain('loaded')
  })

  it('ignores decoding from the previous URL and waits for the replacement image', async () => {
    const current = ref<Track | null>({ ...track })
    const { artwork, wrapper } = mountArtwork(current)
    const image = wrapper.get<HTMLImageElement>('img').element
    completeImage(image)
    let finishDecode!: () => void
    image.decode = () =>
      new Promise<void>((resolve) => {
        finishDecode = resolve
      })
    const pending = artwork.handleMainCoverLoaded(track.id, loadEvent(image))
    current.value = { ...track, cover: '/new-artwork.jpg' }
    await flushUpdates()
    finishDecode()
    await pending
    expect(artwork.mainCoverReadyTrackId.value).toBeNull()
    expect(wrapper.get('img').element).not.toBe(image)
    await loadImage(wrapper)
    expect(artwork.mainCoverReadyTrackId.value).toBe(track.id)
  })

  it('does not let a detached earlier image mark a later visit to the same track ready', async () => {
    const current = ref<Track | null>({ ...track })
    const { artwork, wrapper } = mountArtwork(current)
    const image = wrapper.get<HTMLImageElement>('img').element
    completeImage(image)
    let finishDecode!: () => void
    image.decode = () =>
      new Promise<void>((resolve) => {
        finishDecode = resolve
      })
    const pending = artwork.handleMainCoverLoaded(track.id, loadEvent(image))
    current.value = { ...track, id: 'second-track', cover: '/second-artwork.jpg' }
    await flushUpdates()
    current.value = { ...track }
    await flushUpdates()
    finishDecode()
    await pending

    expect(wrapper.get('img').element).not.toBe(image)
    expect(artwork.mainCoverReadyTrackId.value).toBeNull()
    await loadImage(wrapper)
    expect(wrapper.classes()).toContain('loaded')
  })

  it('shows valid pixels when decode rejects and falls back without sampling theme colors', async () => {
    const { artwork, wrapper } = mountArtwork()
    const image = wrapper.get<HTMLImageElement>('img').element
    completeImage(image)
    image.decode = vi.fn(async () => {
      throw new Error('Decode unavailable')
    })
    await artwork.handleMainCoverLoaded(track.id, loadEvent(image))

    expect(artwork.mainCoverReadyTrackId.value).toBe(track.id)
    expect(themeActions.resetTheme).toHaveBeenCalledOnce()
    expect(extractThemeColor).not.toHaveBeenCalled()
  })

  it('retries CORS once and only marks the successful replacement image ready', async () => {
    const { artwork, wrapper } = mountArtwork()
    const original = wrapper.get<HTMLImageElement>('img')
    completeImage(original.element, 0)
    artwork.setMainCoverImage(original.element)
    await flushUpdates()
    expect(artwork.mainCoverReadyTrackId.value).toBeNull()
    await original.trigger('error')
    await flushUpdates()

    expect(wrapper.get('img').element).not.toBe(original.element)
    expect(wrapper.get('img').attributes('crossorigin')).toBeUndefined()
    await loadImage(wrapper)
    expect(artwork.mainCoverReadyTrackId.value).toBe(track.id)
    expect(artwork.failedCovers.value.has(track.cover!)).toBe(false)
  })

  it('marks the URL failed after the CORS fallback also fails', async () => {
    const { artwork, wrapper } = mountArtwork()
    await wrapper.get('img').trigger('error')
    await flushUpdates()
    await wrapper.get('img').trigger('error')
    await flushUpdates()

    expect(artwork.failedCovers.value.has(track.cover!)).toBe(true)
    expect(artwork.mainCoverReadyTrackId.value).toBeNull()
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('ignores an old image error after a new track is ready', async () => {
    const current = ref<Track | null>({ ...track })
    const { artwork, wrapper } = mountArtwork(current)
    current.value = { ...track, id: 'new-track', cover: '/new-artwork.jpg' }
    await flushUpdates()
    await loadImage(wrapper)
    artwork.handleMainCoverError(track.id, `${track.id}\n${track.cover}`)

    expect(artwork.mainCoverReadyTrackId.value).toBe('new-track')
    expect(artwork.failedCovers.value.has(track.cover!)).toBe(false)
  })

  it('ignores a detached image error after returning to the same track and URL', async () => {
    const current = ref<Track | null>({ ...track })
    const { artwork, wrapper } = mountArtwork(current)
    const original = wrapper.get<HTMLImageElement>('img').element
    current.value = { ...track, id: 'other-track', cover: '/other-artwork.jpg' }
    await flushUpdates()
    current.value = { ...track }
    await flushUpdates()
    await loadImage(wrapper)
    const event = new Event('error')
    Object.defineProperty(event, 'currentTarget', { value: original })

    artwork.handleMainCoverError(track.id, `${track.id}\n${track.cover}`, event)

    expect(artwork.mainCoverReadyTrackId.value).toBe(track.id)
    expect(artwork.mainCoverItems.value[0]?.corsRetried).toBe(false)
    expect(artwork.failedCovers.value.has(track.cover!)).toBe(false)
  })

  it('does not publish readiness after unmount while decoding', async () => {
    const { artwork, wrapper } = mountArtwork()
    const image = wrapper.get<HTMLImageElement>('img').element
    completeImage(image)
    let finishDecode!: () => void
    image.decode = () =>
      new Promise<void>((resolve) => {
        finishDecode = resolve
      })
    const pending = artwork.handleMainCoverLoaded(track.id, loadEvent(image))
    wrapper.unmount()
    finishDecode()
    await pending

    expect(artwork.mainCoverReadyTrackId.value).toBeNull()
    expect(extractThemeColor).not.toHaveBeenCalled()
  })
})
