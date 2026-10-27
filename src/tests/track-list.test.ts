import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, enableAutoUnmount, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref, type Ref } from 'vue'
import TrackList from '../components/TrackList.vue'
import type { Track } from '../core/types'
import type { LibraryView } from '../core/library/personal-library'

enableAutoUnmount(afterEach)
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })

function makeTracks(count: number): Track[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${index + 1}`,
    title: `Track ${index + 1}`,
    artist: 'Artist',
    audioUrl: `/${index + 1}.mp3`,
    kind: 'local',
  }))
}
function createList(
  overrides: {
    tracks?: Track[]
    view?: LibraryView
    currentTrackId?: string | null
    favoriteIds?: string[]
    spectrumAvailable?: boolean
    isPlaying?: boolean
  } = {},
) {
  const tracks = overrides.tracks ?? makeTracks(3)
  return mount(TrackList, {
    attachTo: document.body,
    props: {
      tracks,
      total: tracks.length,
      currentTrackId: null,
      isPlaying: false,
      loading: false,
      query: '',
      ...overrides,
    },
  })
}
function createQueue(tracks: Ref<Track[]>) {
  const Host = defineComponent({
    setup: () => () =>
      h(TrackList, {
        tracks: tracks.value,
        total: tracks.value.length,
        currentTrackId: null,
        isPlaying: false,
        loading: false,
        query: '',
        view: 'queue',
        onRemove: (id: string) => {
          tracks.value = tracks.value.filter((track) => track.id !== id)
        },
        onMove: (from: string, to: string) => {
          const reordered = [...tracks.value]
          const fromIndex = reordered.findIndex((track) => track.id === from)
          const toIndex = reordered.findIndex((track) => track.id === to)
          reordered.splice(toIndex, 0, reordered.splice(fromIndex, 1)[0]!)
          tracks.value = reordered
        },
      }),
  })
  return mount(Host, { attachTo: document.body })
}
function menu(label = '歌曲操作'): DOMWrapper<HTMLElement> {
  const element = document.querySelector<HTMLElement>(`[role="menu"][aria-label="${label}"]`)
  expect(element).not.toBeNull()
  return new DOMWrapper(element!)
}
function action(text: string): DOMWrapper<HTMLButtonElement> {
  return menu()
    .findAll<HTMLButtonElement>('button')
    .find((button) => button.text() === text)!
}
async function sortFrom(row: Element): Promise<void> {
  await new DOMWrapper(row).trigger('contextmenu')
  await action('拖动排序').trigger('click')
  await nextTick()
}
function pointer(
  target: EventTarget,
  type: string,
  id: number,
  y: number,
  pointerType = 'mouse',
): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY: y })
  Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: pointerType } })
  target.dispatchEvent(event)
}

describe('TrackList', () => {
  it('uses a full-height spacer and fixed 66px virtual rows', () => {
    const wrapper = createList({ tracks: makeTracks(120) })
    expect(wrapper.get('.track-virtual-spacer').attributes('style')).toContain('height: 7920px')
    const items = wrapper.findAll('.track-item')
    expect(items.length).toBeGreaterThan(2)
    items.forEach((item, index) =>
      expect(item.attributes('style')).toContain(`top: ${index * 66}px`),
    )
  })
  it('renders the empty state without a spacer', () => {
    const wrapper = createList({ tracks: [] })
    expect(wrapper.find('.track-virtual-spacer').exists()).toBe(false)
    expect(wrapper.get('.list-state').text()).toContain('暂无歌曲')
  })
  it('exposes five spectrum bars and falls back to the row number when unavailable', async () => {
    const wrapper = createList({ currentTrackId: '2', isPlaying: true })
    const meter = wrapper.get('.spectrum-meter')
    expect(meter.findAll('i')).toHaveLength(5)
    expect((wrapper.vm as unknown as { spectrumMeter: HTMLElement }).spectrumMeter).toBe(
      meter.element,
    )
    await wrapper.setProps({ spectrumAvailable: false })
    expect(wrapper.find('.spectrum-meter').exists()).toBe(false)
    expect(wrapper.findAll('.track-status')[1]?.text()).toBe('2')
  })
  it('shows categories directly and connects the selected tab to the song list', async () => {
    const wrapper = createList()
    expect(wrapper.get('[role="tablist"]').attributes('aria-label')).toBe('曲库分类')
    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual([
      '全部',
      '队列',
      '最近',
      '常听',
      '收藏',
    ])
    expect(wrapper.find('.library-category').exists()).toBe(false)
    expect(wrapper.find('[aria-haspopup="menu"]').exists()).toBe(false)
    expect(wrapper.find('.manage-button').exists()).toBe(false)
    expect(wrapper.find('.sort-done').exists()).toBe(false)
    expect(wrapper.find('.track-drag').exists()).toBe(false)
    const favorites = wrapper.get('[data-library-view="favorites"]')
    await favorites.trigger('click')
    expect(wrapper.emitted('update:view')).toEqual([['favorites']])
    await wrapper.setProps({ view: 'favorites' })
    expect(favorites.attributes('aria-selected')).toBe('true')
    expect(favorites.attributes('tabindex')).toBe('0')
    expect(wrapper.get('[data-library-view="all"]').attributes('tabindex')).toBe('-1')
    expect(wrapper.get('[role="tabpanel"]').attributes('id')).toBe(
      favorites.attributes('aria-controls'),
    )
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-labelledby')).toBe(
      favorites.attributes('id'),
    )
  })
  it('supports category arrow keys and Home/End without triggering player shortcuts', async () => {
    const wrapper = createList()
    const shortcuts = vi.fn()
    document.addEventListener('keydown', shortcuts)
    try {
      await wrapper.get('[data-library-view="all"]').trigger('keydown', { key: 'End' })
      expect(document.activeElement).toBe(wrapper.get('[data-library-view="favorites"]').element)
      await wrapper.setProps({ view: 'favorites' })
      await wrapper.get('[data-library-view="favorites"]').trigger('keydown', { key: 'ArrowRight' })
      expect(document.activeElement).toBe(wrapper.get('[data-library-view="all"]').element)
      await wrapper.setProps({ view: 'all' })
      await wrapper.get('[data-library-view="all"]').trigger('keydown', { key: 'ArrowLeft' })
      await wrapper.setProps({ view: 'favorites' })
      await wrapper.get('[data-library-view="favorites"]').trigger('keydown', { key: 'Home' })
      expect(wrapper.emitted('update:view')).toEqual([
        ['favorites'],
        ['all'],
        ['favorites'],
        ['all'],
      ])
      expect(document.activeElement).toBe(wrapper.get('[data-library-view="all"]').element)
      expect(shortcuts).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', shortcuts)
    }
  })
  it('restores focus to the selected category after removing the last queued song', async () => {
    const tracks = ref(makeTracks(1))
    const wrapper = createQueue(tracks)
    await wrapper.get('.track-select').trigger('contextmenu')
    await action('移出队列').trigger('click')
    await nextTick()
    expect(wrapper.find('.track-select').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-library-view="queue"]').element)
    expect(wrapper.get('[role="tabpanel"]').attributes('tabindex')).toBe('0')
  })
  it('plays on normal click and opens a single floating action menu on right click', async () => {
    const wrapper = createList({ currentTrackId: '1', favoriteIds: ['2'] })
    await wrapper.get('[data-track-id="1"]').trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual([wrapper.props('tracks')[0]])
    await wrapper.get('[data-track-id="2"]').trigger('contextmenu', { clientX: 300, clientY: 200 })
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    expect(menu().text()).toContain('取消收藏')
    expect(wrapper.emitted('select')).toHaveLength(1)
    await action('取消收藏').trigger('click')
    expect(wrapper.emitted('favorite')?.[0]).toEqual([wrapper.props('tracks')[1]])
    await wrapper.get('[data-track-id="3"]').trigger('contextmenu')
    expect(document.querySelectorAll('[aria-label="歌曲操作"]')).toHaveLength(1)
    await action('下一首播放').trigger('click')
    expect(wrapper.emitted('enqueue')?.[0]).toEqual([wrapper.props('tracks')[2], true])
  })
  it('opens actions from the context key and Escape restores the row without closing its drawer', async () => {
    const wrapper = createList()
    const trigger = wrapper.get<HTMLButtonElement>('[data-track-id="2"]')
    trigger.element.focus()
    await trigger.trigger('keydown', { key: 'F10', shiftKey: true })
    expect(document.activeElement?.getAttribute('aria-label')).toBe('下一首播放')
    const documentEscape = vi.fn()
    document.addEventListener('keydown', documentEscape)
    try {
      await menu().trigger('keydown', { key: 'Escape' })
      expect(documentEscape).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(trigger.element)
      expect(wrapper.emitted('select')).toBeUndefined()
    } finally {
      document.removeEventListener('keydown', documentEscape)
    }
  })
  it('keeps removal and current-track restrictions in the menu', async () => {
    const wrapper = createList({ view: 'queue', currentTrackId: '1' })
    await wrapper.get('[data-track-id="1"]').trigger('contextmenu')
    expect(action('移出队列').element.disabled).toBe(true)
    expect(action('下一首播放').element.disabled).toBe(true)
    await wrapper.get('[data-track-id="2"]').trigger('contextmenu')
    await action('移出队列').trigger('click')
    expect(wrapper.emitted('remove')).toEqual([['2']])
    expect(wrapper.emitted('select')).toBeUndefined()
  })
  it('shows grips only while sorting a queue and exits sorting when searching', async () => {
    const wrapper = createList({ view: 'queue' })
    await sortFrom(wrapper.get('.track-select').element)
    expect(document.activeElement).toBe(wrapper.get('.sort-done').element)
    await wrapper.findAll('.track-drag')[1]!.trigger('keydown', { key: 'ArrowUp' })
    expect(wrapper.emitted('move')?.[0]).toEqual(['2', '1'])
    await wrapper.get('.track-select').trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()
    await wrapper.setProps({ query: 'Track' })
    expect(wrapper.find('.track-drag').exists()).toBe(false)
    await wrapper.get('.track-select').trigger('contextmenu')
    expect(action('拖动排序').element.disabled).toBe(true)
  })
  it('returns from sorting to ordinary playback', async () => {
    const wrapper = createList({ view: 'queue' })
    await sortFrom(wrapper.get('.track-select').element)
    await wrapper.get('.sort-done').trigger('click')
    expect(wrapper.find('.track-drag').exists()).toBe(false)
    await wrapper.get('.track-select').trigger('click')
    expect(wrapper.emitted('select')).toHaveLength(1)
  })
  it('commits a drag only for the initiating pointer and cancels without reordering', async () => {
    const wrapper = createList({ view: 'queue' })
    vi.spyOn(wrapper.get('.track-list').element, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 300,
      height: 300,
      left: 0,
      right: 300,
      width: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    await sortFrom(wrapper.get('.track-select').element)
    pointer(wrapper.get('.track-drag').element, 'pointerdown', 1, 20)
    pointer(window, 'pointerup', 2, 150)
    expect(wrapper.emitted('move')).toBeUndefined()
    pointer(window, 'pointerup', 1, 150)
    expect(wrapper.emitted('move')).toEqual([['1', '3']])
    pointer(wrapper.get('.track-drag').element, 'pointerdown', 3, 20)
    pointer(window, 'pointercancel', 3, 150)
    expect(wrapper.emitted('move')).toHaveLength(1)
  })
  it('keeps keyboard focus while moving beyond the virtual window', async () => {
    const tracks = ref(makeTracks(120))
    const wrapper = createQueue(tracks)
    const list = wrapper.get<HTMLElement>('.track-list')
    Object.defineProperty(list.element, 'clientHeight', { configurable: true, value: 132 })
    await sortFrom(wrapper.get('.track-select').element)
    wrapper.get<HTMLButtonElement>('[data-reorder-track="1"]').element.focus()
    for (let index = 0; index < 20; index += 1) {
      await wrapper.get('[data-reorder-track="1"]').trigger('keydown', { key: 'ArrowDown' })
      await nextTick()
      expect((document.activeElement as HTMLElement)?.dataset.reorderTrack).toBe('1')
    }
    expect(tracks.value[20]?.id).toBe('1')
    expect(list.element.scrollTop).toBeGreaterThan(0)
  })
  it('suppresses playback after a long press even when held well beyond the threshold', async () => {
    vi.useFakeTimers()
    const wrapper = createList()
    const row = wrapper.get('.track-select')
    pointer(row.element, 'pointerdown', 1, 20, 'touch')
    await vi.advanceTimersByTimeAsync(3000)
    expect(menu().exists()).toBe(true)
    pointer(window, 'pointerup', 1, 20, 'touch')
    await row.trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()
    await action('加入队列').trigger('click')
    expect(wrapper.emitted('enqueue')?.[0]).toEqual([wrapper.props('tracks')[0], false])
  })
  it('suppresses release playback when the native context menu arrives before the timer', async () => {
    vi.useFakeTimers()
    const wrapper = createList()
    const row = wrapper.get('.track-select')
    pointer(row.element, 'pointerdown', 1, 20, 'touch')
    await row.trigger('contextmenu')
    await vi.advanceTimersByTimeAsync(3000)
    pointer(window, 'pointerup', 1, 20, 'touch')
    await row.trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()
  })
  it('cancels long press on movement or list scroll while retaining normal taps', async () => {
    vi.useFakeTimers()
    const wrapper = createList()
    const row = wrapper.get('.track-select')
    pointer(row.element, 'pointerdown', 1, 20, 'touch')
    pointer(window, 'pointermove', 1, 45, 'touch')
    await vi.advanceTimersByTimeAsync(600)
    expect(document.querySelector('[aria-label="歌曲操作"]')).toBeNull()
    pointer(row.element, 'pointerdown', 2, 20, 'touch')
    await wrapper.get('.track-list').trigger('scroll')
    await vi.advanceTimersByTimeAsync(600)
    expect(document.querySelector('[aria-label="歌曲操作"]')).toBeNull()
    pointer(row.element, 'pointerdown', 3, 20, 'touch')
    pointer(window, 'pointerup', 3, 20, 'touch')
    await row.trigger('click')
    expect(wrapper.emitted('select')).toHaveLength(1)
  })
  it('does not consume a new tap when a previous long press emitted no synthetic click', async () => {
    vi.useFakeTimers()
    const wrapper = createList()
    const row = wrapper.get('.track-select')
    pointer(row.element, 'pointerdown', 1, 20, 'touch')
    await vi.advanceTimersByTimeAsync(600)
    pointer(window, 'pointerup', 1, 20, 'touch')
    await menu().trigger('keydown', { key: 'Escape' })
    pointer(row.element, 'pointerdown', 2, 20, 'touch')
    pointer(window, 'pointerup', 2, 20, 'touch')
    await row.trigger('click')
    expect(wrapper.emitted('select')).toHaveLength(1)
  })
})
