<script setup lang="ts">
  import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    shallowRef,
    useId,
    watch,
    type ComponentPublicInstance,
  } from 'vue'
  import {
    ArrowDown,
    ArrowUp,
    GripVertical,
    Heart,
    ListPlus,
    Music,
    RefreshCw,
    Search,
    SkipForward,
    Trash2,
    X,
  } from '@lucide/vue'
  import type { Track } from '../core/types'
  import { LIBRARY_VIEWS, type LibraryView } from '../core/library/personal-library'
  import { useCoverCache } from '../composables/useCoverCache'
  import { isReducedMotion, onReducedMotionChange } from '../platform/web/reduced-motion'
  import Dropdown from './Dropdown.vue'

  const props = withDefaults(
    defineProps<{
      tracks: Track[]
      total: number
      currentTrackId: string | null
      isPlaying: boolean
      loading: boolean
      query: string
      view?: LibraryView
      favoriteIds?: readonly string[]
      loadFailed?: boolean
      /** 节拍分析不可用时(iOS 后台安全模式 / CORS 降级)回退显示序号而非静止频谱柱 */
      spectrumAvailable?: boolean
    }>(),
    {
      loadFailed: false,
      spectrumAvailable: true,
      view: 'all',
      favoriteIds: () => [],
    },
  )

  const emit = defineEmits<{
    'update:query': [value: string]
    select: [track: Track]
    reload: []
    'update:view': [value: LibraryView]
    enqueue: [track: Track, next: boolean]
    remove: [id: string]
    move: [fromId: string, toId: string]
    favorite: [track: Track]
  }>()

  const { loadedCovers, failedCovers, markCoverLoaded, markCoverFailed } = useCoverCache()
  // 正在播放曲目右侧的小频谱 meter:元素暴露给父级,频谱值由 useBeatAnalyser
  // 每帧直接写入 --spectrum-level-N,不经过 Vue 响应式(避免整个队列 60fps 重渲染)
  const spectrumMeterEl = shallowRef<HTMLElement | null>(null)
  function setSpectrumMeter(element: Element | ComponentPublicInstance | null) {
    spectrumMeterEl.value = element instanceof HTMLElement ? element : null
  }
  defineExpose({ spectrumMeter: spectrumMeterEl })
  const isScrolling = ref(false)
  // 与 .track-item 的 height 保持同步:虚拟化偏移按该值计算,断点样式不得覆盖高度。
  const ITEM_HEIGHT = 66
  const BUFFER_COUNT = 5
  const SEARCH_DEBOUNCE_MS = 180

  const scrollTop = ref(0)
  const containerRef = ref<HTMLElement | null>(null)
  // 容器高度通过 ResizeObserver 维护为响应式 ref,
  // 这样窗口/抽屉尺寸变化时 virtualItems 会重新计算可见区域,而不必等待下一次滚动。
  const containerHeight = ref(600)
  const focusPulseTrackId = ref<string | null>(null)
  const debouncedQuery = ref(props.query)
  const actionsTrackId = ref<string | null>(null)
  const sorting = ref(false)
  const sortButton = ref<HTMLButtonElement | null>(null)
  const navigationRef = ref<HTMLElement | null>(null)
  const libraryId = useId()
  const selectedViewIndex = computed(() =>
    Math.max(
      0,
      LIBRARY_VIEWS.findIndex((item) => item.value === props.view),
    ),
  )
  const actionMenu = ref<InstanceType<typeof Dropdown> | null>(null)
  const actionsTrack = computed(() =>
    props.tracks.find((track) => track.id === actionsTrackId.value),
  )
  const favoriteIds = computed(() => new Set(props.favoriteIds))
  const canSort = computed(() => props.view === 'queue' && !props.query.trim())
  const canReorder = computed(() => sorting.value && canSort.value)
  const dragTrackId = ref<string | null>(null)
  const dropTrackId = ref<string | null>(null)
  let dragHandle: HTMLElement | null = null
  let dragPointerId: number | null = null
  let dragY = 0
  let dragFrame = 0
  let scrollTimer = 0
  let focusTimer = 0
  let searchTimer = 0
  let scrollFrame = 0
  let scrollHandlerFrame = 0
  let pendingScrollAnimation = false
  let resizeObserver: ResizeObserver | null = null
  let longPressTimer = 0
  let longPressPointer: number | null = null
  let longPressX = 0
  let longPressY = 0
  let suppressedClick: { id: string; until: number } | null = null
  let categoryAnimation: Animation | null = null

  function stopCategoryAnimation(): void {
    categoryAnimation?.cancel()
    categoryAnimation = null
  }
  const releaseReducedMotion = onReducedMotionChange((reduced) => {
    if (reduced) stopCategoryAnimation()
  })
  watch(
    () => props.view,
    () => {
      stopCategoryAnimation()
      const list = containerRef.value
      if (!list?.animate || isReducedMotion()) return
      // Animate the bounded viewport, not the potentially thousands-of-pixels tall spacer.
      const animation = list.animate(
        [
          { opacity: 0, filter: 'blur(4px)', transform: 'translateY(7px)' },
          { opacity: 1, filter: 'blur(0)', transform: 'translateY(0)' },
        ],
        { duration: 320, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      )
      categoryAnimation = animation
      animation.onfinish = () => {
        if (categoryAnimation === animation) categoryAnimation = null
      }
    },
    { flush: 'post' },
  )

  async function showActions(track: Track, event: MouseEvent | KeyboardEvent): Promise<void> {
    event.preventDefault()
    if (longPressPointer !== null) {
      window.clearTimeout(longPressTimer)
      longPressTimer = 0
      // Native touch contextmenu may arrive before our timer; keep release tracking alive.
      suppressedClick = { id: track.id, until: Infinity }
    } else cancelLongPress()
    actionsTrackId.value = track.id
    const trigger = event.currentTarget
    if (!(trigger instanceof HTMLElement)) return
    const rect = trigger.getBoundingClientRect()
    const point =
      event instanceof KeyboardEvent || (!event.clientX && !event.clientY)
        ? { x: rect.left + 12, y: rect.bottom }
        : { x: event.clientX, y: event.clientY }
    await actionMenu.value?.openAt(point, trigger)
  }

  function selectCategory(view: LibraryView): void {
    actionMenu.value?.dismiss()
    if (view !== props.view) emit('update:view', view)
  }

  function revealCategory(view: LibraryView): void {
    const navigation = navigationRef.value
    const button = navigation?.querySelector<HTMLElement>(`[data-library-view="${view}"]`)
    if (!navigation || !button) return
    const left = button.offsetLeft
    const right = left + button.offsetWidth
    const target =
      left < navigation.scrollLeft
        ? left
        : right > navigation.scrollLeft + navigation.clientWidth
          ? right - navigation.clientWidth
          : navigation.scrollLeft
    if (target !== navigation.scrollLeft) {
      navigation.scrollTo({ left: target, behavior: isReducedMotion() ? 'auto' : 'smooth' })
    }
  }

  function handleCategoryKey(event: KeyboardEvent, index: number): void {
    let nextIndex: number
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % LIBRARY_VIEWS.length
    else if (event.key === 'ArrowLeft')
      nextIndex = (index - 1 + LIBRARY_VIEWS.length) % LIBRARY_VIEWS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = LIBRARY_VIEWS.length - 1
    else return
    const next = LIBRARY_VIEWS[nextIndex]
    if (!next) return
    event.preventDefault()
    event.stopPropagation()
    navigationRef.value
      ?.querySelector<HTMLButtonElement>(`[data-library-view="${next.value}"]`)
      ?.focus({ preventScroll: true })
    selectCategory(next.value)
  }

  watch([() => props.view, navigationRef], () => revealCategory(props.view), { flush: 'post' })

  function activateTrack(track: Track, event: MouseEvent): void {
    if (suppressedClick?.id === track.id && Date.now() <= suppressedClick.until) {
      event.preventDefault()
      event.stopPropagation()
      suppressedClick = null
      return
    }
    if (!sorting.value) emit('select', track)
  }

  function handleActionsKey(event: KeyboardEvent, track: Track): void {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    void showActions(track, event)
  }

  function handleEscape(event: KeyboardEvent): void {
    if (!sorting.value) return
    event.stopPropagation()
    event.preventDefault()
    finishSorting()
  }

  function finishSorting(): void {
    sorting.value = false
    endDrag()
    focusAvailableTrack()
  }

  function focusAvailableTrack(): void {
    const firstTrack = containerRef.value?.querySelector<HTMLButtonElement>('.track-select')
    const target =
      firstTrack ?? navigationRef.value?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
    target?.focus({ preventScroll: true })
  }

  function enqueueAction(next: boolean, close: () => void) {
    if (actionsTrack.value) emit('enqueue', actionsTrack.value, next)
    close()
  }

  function removeAction(close: () => void) {
    close()
    if (actionsTrack.value && actionsTrack.value.id !== props.currentTrackId)
      emit('remove', actionsTrack.value.id)
    actionsTrackId.value = null
    void nextTick(focusAvailableTrack)
  }

  function favoriteAction(close: () => void): void {
    close()
    if (actionsTrack.value) emit('favorite', actionsTrack.value)
    void nextTick(() => {
      if (document.activeElement === document.body) focusAvailableTrack()
    })
  }

  async function startSorting(close: () => void): Promise<void> {
    close()
    if (!canSort.value) return
    sorting.value = true
    await nextTick()
    sortButton.value?.focus({ preventScroll: true })
  }

  function cancelLongPress(): void {
    window.clearTimeout(longPressTimer)
    longPressTimer = 0
    if (suppressedClick?.until === Infinity) suppressedClick.until = Date.now() + 1000
    longPressPointer = null
    window.removeEventListener('pointermove', moveLongPress)
    window.removeEventListener('pointerup', stopLongPress)
    window.removeEventListener('pointercancel', stopLongPress)
    window.removeEventListener('blur', cancelLongPress)
  }

  function moveLongPress(event: PointerEvent): void {
    if (event.pointerId !== longPressPointer) return
    if (Math.hypot(event.clientX - longPressX, event.clientY - longPressY) > 10) cancelLongPress()
  }

  function stopLongPress(event: PointerEvent): void {
    if (event.pointerId === longPressPointer) cancelLongPress()
  }

  function startLongPress(event: PointerEvent, track: Track): void {
    cancelLongPress()
    // A new gesture must remain a normal tap if the previous long press emitted no click.
    if (event.isPrimary !== false && event.button === 0) suppressedClick = null
    if (
      sorting.value ||
      event.isPrimary === false ||
      event.button !== 0 ||
      !['touch', 'pen'].includes(event.pointerType)
    )
      return
    const trigger = event.currentTarget
    if (!(trigger instanceof HTMLElement)) return
    longPressPointer = event.pointerId
    longPressX = event.clientX
    longPressY = event.clientY
    window.addEventListener('pointermove', moveLongPress, { passive: true })
    window.addEventListener('pointerup', stopLongPress)
    window.addEventListener('pointercancel', stopLongPress)
    window.addEventListener('blur', cancelLongPress)
    longPressTimer = window.setTimeout(() => {
      const point = { x: longPressX, y: longPressY }
      longPressTimer = 0
      if (!trigger.isConnected) {
        cancelLongPress()
        return
      }
      // Keep suppressing the synthetic click for however long the finger remains down.
      suppressedClick = { id: track.id, until: Infinity }
      actionsTrackId.value = track.id
      void actionMenu.value?.openAt(point, trigger)
    }, 500)
  }

  function moveAction(direction: number, close: () => void): void {
    if (actionsTrack.value) void moveTrack(actionsTrack.value.id, direction)
    close()
  }

  async function moveTrack(id: string, direction: number, focusHandle = false): Promise<void> {
    if (!canSort.value) return
    const target = props.tracks[props.tracks.findIndex((track) => track.id === id) + direction]
    if (target) emit('move', id, target.id)
    if (!target || !focusHandle) return
    await nextTick()
    const container = containerRef.value
    const index = props.tracks.findIndex((track) => track.id === id)
    if (!container || index < 0) return
    const height = container.clientHeight || containerHeight.value
    const top = index * ITEM_HEIGHT
    const nextTop =
      top < container.scrollTop
        ? top
        : top + ITEM_HEIGHT > container.scrollTop + height
          ? top + ITEM_HEIGHT - height
          : container.scrollTop
    if (nextTop !== container.scrollTop) {
      container.scrollTop = nextTop
      scrollTop.value = nextTop
    }
    await nextTick()
    Array.from(container.querySelectorAll<HTMLButtonElement>('[data-reorder-track]'))
      .find((button) => button.dataset.reorderTrack === id)
      ?.focus({ preventScroll: true })
  }

  watch(actionsTrack, (track) => {
    if (!track) actionMenu.value?.dismiss()
  })

  function updateDropTarget() {
    const container = containerRef.value
    if (!container || !props.tracks.length) return
    const bounds = container.getBoundingClientRect()
    const padding = Number.parseFloat(window.getComputedStyle(container).paddingTop) || 0
    const position = dragY - bounds.top + container.scrollTop - padding
    const index = Math.min(props.tracks.length - 1, Math.max(0, Math.floor(position / ITEM_HEIGHT)))
    dropTrackId.value = props.tracks[index]?.id ?? null
  }

  function scrollDrag() {
    dragFrame = 0
    const container = containerRef.value
    if (!container || dragTrackId.value === null) return
    const bounds = container.getBoundingClientRect()
    const velocity = dragY < bounds.top + 35 ? -7 : dragY > bounds.bottom - 35 ? 7 : 0
    if (velocity) {
      container.scrollTop += velocity
      scrollTop.value = container.scrollTop
    }
    updateDropTarget()
    dragFrame = window.requestAnimationFrame(scrollDrag)
  }

  function startDrag(event: PointerEvent, track: Track) {
    if (!canReorder.value || event.button !== 0 || dragPointerId !== null) return
    event.preventDefault()
    actionsTrackId.value = track.id
    dragTrackId.value = track.id
    dropTrackId.value = track.id
    dragY = event.clientY
    dragHandle = containerRef.value
    dragPointerId = event.pointerId
    dragHandle?.setPointerCapture?.(event.pointerId)
    window.addEventListener('pointermove', dragMove)
    window.addEventListener('pointerup', finishPointerDrag)
    window.addEventListener('pointercancel', cancelPointerDrag)
    dragFrame = window.requestAnimationFrame(scrollDrag)
  }

  function finishPointerDrag(event: PointerEvent) {
    if (event.pointerId !== dragPointerId) return
    dragY = event.clientY
    updateDropTarget()
    endDrag(true)
  }

  function cancelPointerDrag(event: PointerEvent) {
    if (event.pointerId === dragPointerId) endDrag()
  }

  function dragMove(event: PointerEvent) {
    if (event.pointerId !== dragPointerId) return
    dragY = event.clientY
    updateDropTarget()
  }

  function endDrag(commit = false) {
    window.removeEventListener('pointermove', dragMove)
    window.removeEventListener('pointerup', finishPointerDrag)
    window.removeEventListener('pointercancel', cancelPointerDrag)
    const from = dragTrackId.value
    const to = dropTrackId.value
    dragTrackId.value = null
    dropTrackId.value = null
    if (dragFrame) window.cancelAnimationFrame(dragFrame)
    dragFrame = 0
    if (dragPointerId !== null && dragHandle?.hasPointerCapture?.(dragPointerId))
      dragHandle.releasePointerCapture(dragPointerId)
    dragPointerId = null
    dragHandle = null
    if (commit && from && to && from !== to) emit('move', from, to)
  }

  watch(
    () => [props.view, props.query],
    () => {
      actionsTrackId.value = null
      sorting.value = false
      actionMenu.value?.dismiss()
      cancelLongPress()
      endDrag()
      scrollTop.value = 0
      containerRef.value?.scrollTo({ top: 0, behavior: 'auto' })
    },
  )

  const displayList = computed(() =>
    props.tracks.map((track, index) => ({
      track,
      display: {
        title: track.title,
        versions: track.titleVersions ?? [],
      },
      index,
    })),
  )

  const trackIndexById = computed(() => {
    const indexById = new Map<string, number>()
    props.tracks.forEach((track, index) => {
      indexById.set(track.id, index)
    })
    return indexById
  })

  const currentTrackIndex = computed(() => {
    if (!props.currentTrackId) return -1
    return trackIndexById.value.get(props.currentTrackId) ?? -1
  })

  const virtualItems = computed(() => {
    const height = containerHeight.value
    const total = displayList.value.length
    const start = Math.max(0, Math.floor(scrollTop.value / ITEM_HEIGHT) - BUFFER_COUNT)
    const visibleCount = Math.ceil(height / ITEM_HEIGHT) + BUFFER_COUNT * 2
    const end = Math.min(total, start + visibleCount)
    return {
      items: displayList.value.slice(start, end).map((item, i) => ({
        ...item,
        offset: (start + i) * ITEM_HEIGHT,
      })),
      totalHeight: total * ITEM_HEIGHT,
      total,
    }
  })

  function handleScroll(e: Event) {
    cancelLongPress()
    const target = e.target as HTMLElement
    // rAF 节流:一帧内的多次 scroll 事件只取最新 scrollTop 更新一次
    if (scrollHandlerFrame) return
    scrollHandlerFrame = window.requestAnimationFrame(() => {
      scrollHandlerFrame = 0
      scrollTop.value = target.scrollTop
      isScrolling.value = true
      window.clearTimeout(scrollTimer)
      scrollTimer = window.setTimeout(() => {
        isScrolling.value = false
      }, 850)
    })
  }

  function handleSearchInput(value: string) {
    window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => {
      emit('update:query', value)
    }, SEARCH_DEBOUNCE_MS)
  }

  function clearSearch() {
    window.clearTimeout(searchTimer)
    debouncedQuery.value = ''
    emit('update:query', '')
  }

  async function scrollActiveTrackIntoView(animate = true) {
    if (!props.currentTrackId) return
    await nextTick()
    const container = containerRef.value
    if (!container) return

    const targetIndex = currentTrackIndex.value
    if (targetIndex < 0) return

    const targetOffset = targetIndex * ITEM_HEIGHT
    const focusOffset = 30
    container.scrollTo({
      top: targetOffset - focusOffset,
      behavior: animate ? 'smooth' : 'auto',
    })
    focusPulseTrackId.value = props.currentTrackId
    window.clearTimeout(focusTimer)
    focusTimer = window.setTimeout(() => {
      if (focusPulseTrackId.value === props.currentTrackId) focusPulseTrackId.value = null
    }, 1200)
  }

  function scheduleActiveTrackScroll(animate = true) {
    pendingScrollAnimation = animate
    if (scrollFrame) window.cancelAnimationFrame(scrollFrame)
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = 0
      void scrollActiveTrackIntoView(pendingScrollAnimation)
    })
  }

  onMounted(() => scheduleActiveTrackScroll(false))
  // 监听容器节点:挂载时测量初始高度并接入 ResizeObserver,卸载/重建时断开旧 observer。
  // immediate 在 setup 阶段 containerRef.value 为 null,首次触发走 else 分支无副作用,
  // 节点真正绑定后再次触发完成接入。
  watch(
    () => containerRef.value,
    (el) => {
      resizeObserver?.disconnect()
      resizeObserver = null
      if (!el) return
      containerHeight.value = el.clientHeight
      if (typeof ResizeObserver === 'undefined') return
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0]
        if (entry) containerHeight.value = entry.contentRect.height
        revealCategory(props.view)
      })
      resizeObserver.observe(el)
    },
    { immediate: true },
  )
  watch(
    () => ({ id: props.currentTrackId, index: currentTrackIndex.value }),
    (next, previous) => {
      if (next.id !== previous?.id) {
        scheduleActiveTrackScroll(true)
      } else if (!props.query && next.index >= 0 && (previous?.index ?? -1) < 0) {
        // 非搜索状态下曲目从无效变为有效(如启动时恢复上次曲目)才定位;
        // 搜索过滤导致的 index 变化不强拉滚动,避免打断用户浏览结果。
        scheduleActiveTrackScroll(false)
      }
    },
  )
  watch(debouncedQuery, (value) => {
    handleSearchInput(value)
  })
  // 父组件从外部重置 query(如清空搜索)时同步回输入框,避免显示过期文本
  watch(
    () => props.query,
    (value) => {
      if (value === debouncedQuery.value) return
      window.clearTimeout(searchTimer)
      debouncedQuery.value = value
    },
  )
  onBeforeUnmount(() => {
    stopCategoryAnimation()
    releaseReducedMotion()
    cancelLongPress()
    endDrag()
    window.clearTimeout(scrollTimer)
    window.clearTimeout(focusTimer)
    window.clearTimeout(searchTimer)
    if (scrollFrame) window.cancelAnimationFrame(scrollFrame)
    if (scrollHandlerFrame) window.cancelAnimationFrame(scrollHandlerFrame)
    resizeObserver?.disconnect()
    resizeObserver = null
  })
</script>

<template>
  <section class="track-panel" @keydown.esc="handleEscape">
    <header class="track-header">
      <div class="track-heading">
        <h2 class="library-title">曲库</h2>
        <p>{{ total }} 首歌曲</p>
      </div>
      <span class="track-header-controls">
        <button v-if="sorting" ref="sortButton" class="sort-done" @click="finishSorting">
          完成排序
        </button>
        <slot name="header-actions" />
      </span>
    </header>

    <div class="list-toolbar">
      <div ref="navigationRef" class="library-navigation">
        <div class="library-view-tabs" role="tablist" aria-label="曲库分类">
          <button
            v-for="(tab, index) in LIBRARY_VIEWS"
            :id="`${libraryId}-tab-${tab.value}`"
            :key="tab.value"
            type="button"
            class="library-view-tab"
            role="tab"
            :data-library-view="tab.value"
            :aria-selected="view === tab.value"
            :aria-controls="`${libraryId}-panel`"
            :tabindex="view === tab.value ? 0 : -1"
            @click="selectCategory(tab.value)"
            @keydown="handleCategoryKey($event, index)"
            @focus="revealCategory(tab.value)"
          >
            {{ tab.label }}
          </button>
          <span
            class="library-view-indicator"
            :style="{ transform: `translateX(calc(${selectedViewIndex} * (100% + 8px)))` }"
            aria-hidden="true"
          />
        </div>
      </div>
      <div class="search-row">
        <label class="search-box">
          <Search :size="16" />
          <input v-model="debouncedQuery" type="search" aria-label="搜索歌曲" placeholder="搜索" />
          <button v-if="debouncedQuery" aria-label="清空搜索" @click="clearSearch">
            <X :size="14" />
          </button>
        </label>
        <button
          class="reload-button"
          aria-label="重新加载歌曲"
          title="重新加载歌曲"
          :disabled="loading"
          @click="emit('reload')"
        >
          <RefreshCw :size="16" :class="{ spinning: loading }" />
        </button>
      </div>
    </div>

    <div
      :id="`${libraryId}-panel`"
      ref="containerRef"
      class="track-list"
      role="tabpanel"
      :aria-labelledby="`${libraryId}-tab-${view}`"
      :tabindex="tracks.length ? undefined : 0"
      :class="{ scrolling: isScrolling }"
      @scroll.passive="handleScroll"
      @lostpointercapture="endDrag()"
    >
      <div
        v-if="virtualItems.total > 0"
        class="track-virtual-spacer"
        :style="{ height: `${virtualItems.totalHeight}px` }"
      >
        <div
          v-for="{ track, display, index, offset } in virtualItems.items"
          :key="track.id"
          class="track-item"
          :class="{
            active: track.id === currentTrackId,
            focused: track.id === focusPulseTrackId,
            'drop-target': dropTrackId === track.id,
            dragging: dragTrackId === track.id,
            reorderable: canReorder,
          }"
          :style="{ position: 'absolute', top: `${offset}px`, left: '0', right: '0' }"
        >
          <button
            v-if="canReorder"
            class="track-drag"
            :data-reorder-track="track.id"
            :aria-label="`移动 ${track.title}，方向键上下调整`"
            title="拖动排序，也可使用上下方向键"
            @pointerdown="startDrag($event, track)"
            @keydown.up.prevent="moveTrack(track.id, -1, true)"
            @keydown.down.prevent="moveTrack(track.id, 1, true)"
          >
            <GripVertical :size="16" />
          </button>
          <button
            class="track-select"
            :data-track-id="track.id"
            :aria-label="`${sorting ? '排序中' : '播放'} ${track.title} · ${track.artist}`"
            @click="activateTrack(track, $event)"
            @contextmenu.prevent="showActions(track, $event)"
            @keydown="handleActionsKey($event, track)"
            @pointerdown="startLongPress($event, track)"
          >
            <span class="thumb" :class="{ loaded: loadedCovers.has(track.cover ?? track.id) }">
              <span class="cover-placeholder"><Music :size="20" fill="currentColor" /></span>
              <img
                v-if="track.cover && !failedCovers.has(track.cover ?? track.id)"
                :src="track.cover"
                alt=""
                loading="lazy"
                @load="markCoverLoaded(track.id, track.cover)"
                @error="markCoverFailed(track.id, track.cover)"
              />
            </span>
            <span class="track-copy">
              <strong>
                <span class="track-title-main">{{ display.title }}</span>
                <span v-if="display.versions.length" class="track-title-versions">
                  <span
                    v-for="version in display.versions"
                    :key="version"
                    class="track-title-version"
                  >
                    {{ version }}
                  </span>
                </span>
              </strong>
              <small>{{ track.artist }}</small>
            </span>
            <span class="track-status">
              <span
                v-if="track.id === currentTrackId && isPlaying && spectrumAvailable"
                :ref="setSpectrumMeter"
                class="spectrum-meter"
                aria-label="正在播放"
              >
                <i v-for="band in 5" :key="band" />
              </span>
              <span v-else>{{ index + 1 }}</span>
            </span>
          </button>
        </div>
      </div>

      <div v-if="loading && !total" class="list-state"><span class="loader" />正在载入音乐</div>
      <div v-else-if="loadFailed && !tracks.length" class="list-state">
        <span class="empty-line">音乐列表载入失败,请稍后重试</span>
      </div>
      <div v-else-if="!tracks.length" class="list-state">
        <span class="empty-line">{{ query ? '没有找到匹配的歌曲' : '暂无歌曲' }}</span>
      </div>
    </div>
    <Dropdown ref="actionMenu" class="track-context-host" teleport label="歌曲操作">
      <template #default="{ close }">
        <template v-if="actionsTrack">
          <div class="track-context-title">{{ actionsTrack.title }}</div>
          <button
            class="library-menu-item"
            :disabled="actionsTrack.id === currentTrackId"
            aria-label="下一首播放"
            @click="enqueueAction(true, close)"
          >
            <SkipForward :size="17" />下一首播放
          </button>
          <button class="library-menu-item" @click="enqueueAction(false, close)">
            <ListPlus :size="17" />加入队列
          </button>
          <button
            class="library-menu-item"
            :aria-pressed="favoriteIds.has(actionsTrack.id)"
            @click="favoriteAction(close)"
          >
            <Heart
              :size="17"
              :fill="favoriteIds.has(actionsTrack.id) ? 'currentColor' : 'none'"
            />{{ favoriteIds.has(actionsTrack.id) ? '取消收藏' : '收藏' }}
          </button>
          <template v-if="view === 'queue'">
            <button
              class="library-menu-item"
              :disabled="!canSort || actionsTrack.id === tracks[0]?.id"
              @click="moveAction(-1, close)"
            >
              <ArrowUp :size="17" />上移
            </button>
            <button
              class="library-menu-item"
              :disabled="!canSort || actionsTrack.id === tracks[tracks.length - 1]?.id"
              @click="moveAction(1, close)"
            >
              <ArrowDown :size="17" />下移
            </button>
            <button
              class="library-menu-item"
              :disabled="actionsTrack.id === currentTrackId"
              @click="removeAction(close)"
            >
              <Trash2 :size="17" />移出队列
            </button>
            <button class="library-menu-item" :disabled="!canSort" @click="startSorting(close)">
              <GripVertical :size="17" />拖动排序
            </button>
          </template>
        </template>
      </template>
    </Dropdown>
  </section>
</template>

<style scoped lang="scss">
  .track-panel {
    display: flex;
    min-width: 0;
    height: 100%;
    flex-direction: column;
    padding: 24px 20px 18px;
    color: var(--text);
  }

  .track-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex: 0 0 auto;
    padding: 0 10px 18px;

    p {
      margin: 4px 0 0;
      color: var(--text-subtle);
      font-size: 0.72rem;
    }
  }

  .track-heading {
    min-width: 0;
  }
  .track-header-controls {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    gap: 6px;
  }
  .sort-done {
    min-width: 44px;
    min-height: 44px;
    padding: 8px 6px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.73rem;
    font-weight: 550;
    cursor: pointer;
    transition: color 200ms cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      color: var(--text);
    }
  }

  .reload-button {
    display: grid;
    width: 36px;
    height: 36px;
    flex: 0 0 auto;
    place-items: center;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 14px;
    corner-shape: squircle;
    background: rgba(255, 255, 255, 0.055);
    backdrop-filter: blur(18px) saturate(145%);
    color: var(--text-subtle);
    cursor: pointer;

    &:hover {
      background: rgba(255, 255, 255, 0.13);
      color: #fff;
    }
    &:disabled {
      cursor: wait;
      opacity: 0.55;
    }
  }

  .list-toolbar {
    position: sticky;
    top: 0;
    z-index: 2;
    flex: 0 0 auto;
    min-width: 0;
    padding: 0 10px 8px;
    background: transparent;
  }

  .search-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .search-box {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
    padding: 0 11px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 15px;
    corner-shape: squircle;
    background: rgba(255, 255, 255, 0.05);
    backdrop-filter: blur(18px) saturate(145%);
    color: var(--text-subtle);

    input {
      min-width: 0;
      height: 36px;
      flex: 1;
      border: 0;
      outline: 0;
      background: none;
      color: #fff;
      font-size: 0.78rem;

      &::placeholder {
        color: var(--text-subtle);
      }
      &::-webkit-search-cancel-button {
        display: none;
      }
    }

    button {
      display: grid;
      padding: 3px;
      border: 0;
      background: none;
      color: var(--text-subtle);
      cursor: pointer;
    }
  }

  .track-list {
    --track-focus-offset: 30px;
    position: relative;
    min-height: 0;
    flex: 1;
    overflow-y: auto;
    scroll-padding-top: var(--track-focus-offset);
    padding-top: 10px;
    padding-bottom: 18px;
    scrollbar-color: transparent transparent;
    scrollbar-width: thin;
    mask-image: linear-gradient(
      180deg,
      transparent 0,
      #000 24px,
      #000 calc(100% - 34px),
      transparent 100%
    );
    transition: scrollbar-color 180ms ease;

    &.scrolling {
      scrollbar-color: rgba(255, 255, 255, 0.24) transparent;
    }

    &::-webkit-scrollbar {
      width: 5px;
    }

    &::-webkit-scrollbar-track {
      background: transparent;
    }

    &::-webkit-scrollbar-thumb {
      border-radius: 99px;
      background: transparent;
    }

    &.scrolling::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.24);
    }
  }

  .track-virtual-spacer {
    position: relative;
    min-height: 100%;
  }

  .track-item {
    display: grid;
    width: 100%;
    /* 高度必须与 ITEM_HEIGHT(66) 一致,否则虚拟化偏移与真实行高漂移 */
    height: 66px;
    grid-template-columns: minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 0;
    border-radius: 14px;
    corner-shape: squircle;
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
    transition: background 130ms ease;

    &.reorderable {
      grid-template-columns: 32px minmax(0, 1fr);
    }
    &.drop-target {
      box-shadow: inset 0 2px var(--accent);
    }
    &.dragging {
      opacity: 0.55;
    }

    &:hover {
      background: rgba(255, 255, 255, 0.07);
    }

    &.active {
      background: color-mix(in srgb, var(--accent) 17%, transparent);

      .track-copy strong,
      .track-status {
        color: var(--accent);
      }

      .track-title-version {
        color: color-mix(in srgb, var(--accent) 68%, rgba(255, 255, 255, 0.52));
      }
    }

    &.focused {
      animation: focus-glow 1.15s ease both;
    }
  }

  .track-select {
    touch-action: pan-y;
    -webkit-touch-callout: none;
    user-select: none;
    display: grid;
    grid-template-columns: 46px minmax(0, 1fr) 24px;
    gap: 12px;
    align-items: center;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .track-drag {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 44px;
    padding: 10px 8px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: var(--text-subtle);
    font: inherit;
    cursor: pointer;
    &:hover {
      background: rgba(255, 255, 255, 0.09);
      color: var(--text);
    }
    &:disabled {
      opacity: 0.35;
      cursor: default;
    }
  }
  .track-drag {
    touch-action: none;
    cursor: grab;
    padding: 0;
  }
  .library-title {
    margin: 0;
    color: var(--text);
    font-size: 1.18rem;
    font-weight: 700;
    letter-spacing: -0.035em;
  }
  .library-navigation {
    min-width: 0;
    margin-bottom: 8px;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }
  .library-view-tabs {
    position: relative;
    display: grid;
    grid-template-columns: repeat(5, minmax(44px, 1fr));
    gap: 8px;
    min-width: 252px;
  }
  .library-view-tab {
    min-width: 0;
    min-height: 44px;
    padding: 9px 4px 12px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-subtle);
    font: inherit;
    font-size: 0.78rem;
    font-weight: 550;
    white-space: nowrap;
    cursor: pointer;
    transition: color 240ms cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      color: var(--text-muted);
    }
    &[aria-selected='true'] {
      color: var(--text);
    }
  }
  .library-view-indicator {
    position: absolute;
    inset: auto auto 2px 0;
    width: calc((100% - 32px) / 5);
    height: 2px;
    color: var(--text);
    font-size: 0.78rem;
    pointer-events: none;
    transition: transform 280ms cubic-bezier(0.16, 1, 0.3, 1);

    &::after {
      content: '';
      position: absolute;
      inset: 0 auto 0 calc(50% - 0.65em);
      width: 1.3em;
      border-radius: 2px;
      background: currentColor;
      opacity: 0.85;
    }
  }
  .library-menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 44px;
    padding: 11px 13px;
    border: 0;
    border-radius: 13px;
    corner-shape: squircle;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.82rem;
    font-weight: 500;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background 200ms cubic-bezier(0.16, 1, 0.3, 1),
      color 200ms cubic-bezier(0.16, 1, 0.3, 1),
      transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
    svg {
      flex: 0 0 auto;
    }
    &:hover:not(:disabled) {
      color: var(--text);
      background: rgba(255, 255, 255, 0.07);
    }
    &:active:not(:disabled) {
      transform: scale(0.98);
    }
    &:disabled {
      opacity: 0.35;
      cursor: default;
    }
  }
  .track-context-host {
    display: none;
  }
  .track-context-title {
    max-width: 220px;
    overflow: hidden;
    padding: 9px 13px 10px;
    margin-bottom: 4px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    color: var(--text-subtle);
    font-size: 0.72rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .track-select:focus-visible,
  .sort-done:focus-visible,
  .library-view-tab:focus-visible,
  .library-menu-item:focus-visible,
  .track-drag:focus-visible {
    outline: 2px solid rgba(255, 255, 255, 0.65);
    outline-offset: -2px;
  }
  @media (pointer: coarse) {
    .track-item.reorderable {
      grid-template-columns: 44px minmax(0, 1fr);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sort-done,
    .library-view-tab,
    .library-view-indicator,
    .library-menu-item,
    .track-drag {
      transition: none;
    }
    .library-menu-item:active:not(:disabled) {
      transform: none;
      filter: none;
    }
  }
  @media (prefers-contrast: more) {
    .sort-done,
    .library-view-tab,
    .track-drag,
    .library-menu-item {
      color: var(--text);
    }
    .library-view-indicator {
      height: 3px;
    }
  }

  .thumb {
    position: relative;
    display: grid;
    width: 46px;
    height: 46px;
    place-items: center;
    overflow: hidden;
    border-radius: 11px;
    corner-shape: squircle;
    background: #2c2c2e;
    color: rgba(255, 255, 255, 0.26);
    font-size: 0.8rem;
    font-weight: 700;

    img {
      position: relative;
      z-index: 1;
      width: 100%;
      height: 100%;
      object-fit: cover;
      opacity: 0;
      transition: opacity 220ms ease;
    }

    &.loaded img {
      opacity: 1;
    }
  }

  .cover-placeholder {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background:
      radial-gradient(circle at 32% 22%, rgba(255, 255, 255, 0.07), transparent 42%), #2c2c2e;
  }

  .track-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 3px;

    strong,
    small {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    strong {
      display: flex;
      max-width: 100%;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
      color: rgba(255, 255, 255, 0.93);
      font-size: 0.78rem;
      font-weight: 560;
    }

    .track-title-main {
      min-width: 0;
      flex: 0 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .track-title-versions {
      display: inline-flex;
      max-width: 118px;
      flex: 0 999 118px;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 24px), transparent);
    }

    .track-title-version {
      display: inline-block;
      flex: 0 0 auto;
      color: rgba(255, 255, 255, 0.62);
      font-size: 0.78em;
      font-weight: 620;
      line-height: 1;
      white-space: nowrap;
    }

    small {
      color: var(--text-subtle);
      font-size: 0.66rem;
    }
  }

  .track-status {
    color: rgba(255, 255, 255, 0.25);
    font-size: 0.64rem;
    text-align: center;
  }

  .spectrum-meter {
    display: flex;
    height: 13px;
    align-items: center;
    justify-content: center;
    gap: 2px;

    i {
      width: 2px;
      height: 8%;
      min-height: 3px;
      max-height: 13px;
      border-radius: 999px;
      background: currentColor;
      opacity: 0.92;

      /* 柱高由 useBeatAnalyser 每帧直写 --spectrum-level-N 驱动;
         平滑在分析器的帧率无关包络里完成,这里不再叠加 CSS transition */
      &:nth-child(1) {
        height: var(--spectrum-level-0, 8%);
      }
      &:nth-child(2) {
        height: var(--spectrum-level-1, 8%);
      }
      &:nth-child(3) {
        height: var(--spectrum-level-2, 8%);
      }
      &:nth-child(4) {
        height: var(--spectrum-level-3, 8%);
      }
      &:nth-child(5) {
        height: var(--spectrum-level-4, 8%);
      }
    }
  }

  .list-state {
    display: flex;
    min-height: 180px;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 10px;
    color: var(--text-subtle);
    font-size: 0.76rem;
  }

  .loader {
    width: 22px;
    height: 22px;
    border: 2px solid rgba(255, 255, 255, 0.13);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .spinning {
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes focus-glow {
    0% {
      background: color-mix(in srgb, var(--accent) 28%, transparent);
      transform: scale(0.992);
    }
    45% {
      background: color-mix(in srgb, var(--accent) 22%, transparent);
      transform: scale(1);
    }
    100% {
      background: color-mix(in srgb, var(--accent) 14%, transparent);
      transform: scale(1);
    }
  }

  @media (max-width: 720px) {
    .track-panel {
      padding: 18px 30px max(16px, env(safe-area-inset-bottom));
    }

    .track-header {
      padding: 2px 10px 16px;

      .library-title {
        font-size: 1.22rem;
      }
      p {
        margin-top: 4px;
        font-size: 0.68rem;
      }
    }

    .list-toolbar {
      padding-bottom: 8px;
    }

    .search-box {
      height: 40px;
      border-radius: 16px;

      input {
        height: 38px;
        font-size: 16px;
      }
    }

    .reload-button {
      width: 40px;
      height: 40px;
      border-radius: 16px;
    }

    .track-list {
      --track-focus-offset: 24px;
      padding-top: 8px;
      padding-bottom: max(56px, calc(18px + env(safe-area-inset-bottom)));
      mask-image: linear-gradient(
        180deg,
        transparent 0,
        #000 18px,
        #000 calc(100% - 72px),
        transparent 100%
      );
    }

    .track-item {
      padding: 8px 10px;
      border-radius: 15px;
    }

    .thumb {
      width: 46px;
      height: 46px;
      border-radius: 12px;
    }

    .track-copy {
      strong {
        font-size: 0.78rem;
      }
      small {
        font-size: 0.66rem;
      }
    }
  }

  @media (max-width: 360px), (max-height: 700px) and (max-width: 720px) {
    .track-panel {
      padding: 14px 24px max(12px, env(safe-area-inset-bottom));
    }

    .track-header {
      padding-bottom: 10px;

      .library-title {
        font-size: 1.08rem;
      }
      p {
        font-size: 0.62rem;
      }
    }

    .search-box {
      height: 36px;
      border-radius: 14px;

      input {
        height: 34px;
        font-size: 16px;
      }
    }

    .reload-button {
      width: 36px;
      height: 36px;
      border-radius: 14px;
    }

    .track-list {
      --track-focus-offset: 20px;
      padding-top: 7px;
    }

    .track-select {
      grid-template-columns: 42px minmax(0, 1fr) 20px;
      gap: 7px;
    }

    .thumb {
      width: 42px;
      height: 42px;
      border-radius: 11px;
    }

    .track-copy {
      gap: 2px;

      strong {
        font-size: 0.74rem;
      }
      small {
        font-size: 0.62rem;
      }
    }
  }
</style>
