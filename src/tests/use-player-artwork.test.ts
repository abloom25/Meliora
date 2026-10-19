import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { usePlayerArtwork } from '../composables/usePlayerArtwork'
import { usePlayerStore } from '../stores/player'
import type { Track } from '../core/types'

vi.mock('../platform/web/theme', () => ({ extractThemeColor: vi.fn(async () => null) }))

describe('player artwork URL changes', () => {
  it('shows a new URL for the same track and ignores decoding from its previous cover', async () => {
    setActivePinia(createPinia())
    const store = usePlayerStore()
    const current = ref<Track | null>({
      id: 'artwork-url-change',
      title: 'Song',
      artist: 'Artist',
      kind: 'local',
      audioUrl: '/song.mp3',
      cover: '/old-artwork.jpg',
    })
    let artwork!: ReturnType<typeof usePlayerArtwork>
    const wrapper = mount(
      defineComponent({
        setup() {
          artwork = usePlayerArtwork(current, ref(store.settings))
          return () => h('div')
        },
      }),
    )
    let finishDecode!: () => void
    const image = document.createElement('img')
    image.setAttribute('src', '/old-artwork.jpg')
    image.decode = () =>
      new Promise<void>((resolve) => {
        finishDecode = resolve
      })
    const event = new Event('load')
    Object.defineProperty(event, 'currentTarget', { value: image })
    const pending = artwork.handleMainCoverLoaded(current.value!.id, event)
    artwork.markCoverFailed(current.value!.id, '/old-artwork.jpg')
    expect(artwork.mainCoverItems.value).toHaveLength(0)
    current.value = { ...current.value!, cover: '/new-artwork.jpg' }
    expect(artwork.mainCoverItems.value).toHaveLength(1)
    finishDecode()
    await pending
    expect(artwork.mainCoverReadyTrackId.value).toBeNull()
    wrapper.unmount()
  })
})
