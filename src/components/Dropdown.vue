<script setup lang="ts">
  import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

  const props = withDefaults(defineProps<{ teleport?: boolean; label?: string }>(), {
    teleport: false,
    label: undefined,
  })
  const emit = defineEmits<{ 'update:open': [open: boolean] }>()
  const open = ref(false)
  const rootRef = ref<HTMLElement | null>(null)
  const menuRef = ref<HTMLElement | null>(null)
  const position = ref({
    left: '0px',
    top: '0px',
    maxHeight: 'none',
    maxWidth: 'none',
    minWidth: '0px',
    transformOrigin: 'left top',
    visibility: 'hidden' as 'hidden' | 'visible',
  })
  let triggerButton: HTMLElement | null = null
  let point: { x: number; y: number } | null = null
  let disposed = false

  function getMenuItems(): HTMLElement[] {
    return Array.from(
      menuRef.value?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    )
  }

  function placeMenu(): void {
    if (!props.teleport || !open.value || !menuRef.value) return
    const viewport = window.visualViewport
    const left = (viewport?.offsetLeft ?? 0) + 8
    const top = (viewport?.offsetTop ?? 0) + 8
    const width = Math.max(0, (viewport?.width ?? window.innerWidth) - 16)
    const height = Math.max(0, (viewport?.height ?? window.innerHeight) - 16)
    const anchor = triggerButton?.getBoundingClientRect()
    // Measure against the new viewport, not the previous height left by an open keyboard.
    menuRef.value.style.maxWidth = width + 'px'
    menuRef.value.style.maxHeight = height + 'px'
    menuRef.value.style.minWidth = Math.min(176, width) + 'px'
    const bounds = menuRef.value.getBoundingClientRect()
    // Enter/leave transforms must not shrink the box used for viewport clamping.
    const menuWidth = menuRef.value.offsetWidth || bounds.width
    const menuHeight = menuRef.value.offsetHeight || bounds.height
    const x = point?.x ?? anchor?.left ?? left
    const y = point?.y ?? (anchor ? anchor.bottom + 6 : top)
    const menuLeft = Math.max(left, Math.min(x, left + width - menuWidth))
    const menuTop = Math.max(top, Math.min(y, top + height - Math.min(menuHeight, height)))
    const nextPosition = {
      left: menuLeft + 'px',
      top: menuTop + 'px',
      maxHeight: height + 'px',
      maxWidth: width + 'px',
      minWidth: Math.min(176, width) + 'px',
      transformOrigin: `${Math.max(0, Math.min(menuWidth, x - menuLeft))}px ${Math.max(0, Math.min(menuHeight, y - menuTop))}px`,
      visibility: 'visible' as const,
    }
    // Focus follows immediately; make the first portal render visible before focusing it.
    Object.assign(menuRef.value.style, nextPosition)
    position.value = nextPosition
  }

  async function openMenu(): Promise<void> {
    open.value = true
    await nextTick()
    if (disposed || !open.value) return
    if (menuRef.value) menuRef.value.inert = false
    placeMenu()
    const items = getMenuItems()
    items.forEach((item) => {
      if (!item.hasAttribute('role')) item.setAttribute('role', 'menuitem')
    })
    items[0]?.focus({ preventScroll: true })
  }

  function closeMenu(options: { restoreFocus?: boolean } = {}): void {
    if (!open.value) return
    // The leave transition keeps this DOM alive; it must stop accepting focus immediately.
    if (menuRef.value) menuRef.value.inert = true
    open.value = false
    if (options.restoreFocus && triggerButton?.isConnected)
      triggerButton.focus({ preventScroll: true })
  }

  function toggle(): void {
    if (open.value) closeMenu()
    else {
      point = null
      triggerButton = rootRef.value?.querySelector<HTMLElement>('button, [role="button"]') ?? null
      void openMenu()
    }
  }

  async function openAt(anchor: { x: number; y: number }, trigger: HTMLElement): Promise<void> {
    triggerButton = trigger
    point = anchor
    await openMenu()
  }

  function close(): void {
    closeMenu({ restoreFocus: true })
  }
  function dismiss(): void {
    closeMenu()
  }

  function handleOutsideClick(event: MouseEvent): void {
    const target = event.target as Node
    if (!rootRef.value?.contains(target) && !menuRef.value?.contains(target)) closeMenu()
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (!open.value) return
    const items = getMenuItems()
    const currentIndex = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Tab') {
      // Return to the logical trigger so the parent dialog can apply its normal Tab trap.
      closeMenu({ restoreFocus: true })
      return
    }
    if (!['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') closeMenu({ restoreFocus: true })
    else if (event.key === 'ArrowDown') items[(currentIndex + 1) % items.length]?.focus()
    else if (event.key === 'ArrowUp')
      items[(currentIndex - 1 + items.length) % items.length]?.focus()
    else if (event.key === 'Home') items[0]?.focus()
    else items[items.length - 1]?.focus()
  }

  function handleTriggerKeydown(event: KeyboardEvent): void {
    if (menuRef.value?.contains(event.target as Node)) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open.value) toggle()
      else getMenuItems()[0]?.focus()
    }
  }

  function handleScroll(event: Event): void {
    if (props.teleport && open.value && !menuRef.value?.contains(event.target as Node)) dismiss()
  }

  watch(open, (isOpen) => {
    // Context-menu anchors are ordinary rows, not persistent menu triggers.
    const ownTrigger = rootRef.value?.querySelector<HTMLElement>('button, [role="button"]')
    ownTrigger?.setAttribute('aria-expanded', String(isOpen))
    emit('update:open', isOpen)
  })

  onMounted(() => {
    document.addEventListener('click', handleOutsideClick)
    document.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', placeMenu)
    window.visualViewport?.addEventListener('resize', placeMenu)
    window.visualViewport?.addEventListener('scroll', placeMenu)
    triggerButton = rootRef.value?.querySelector<HTMLElement>('button, [role="button"]') ?? null
    triggerButton?.setAttribute('aria-haspopup', 'menu')
    triggerButton?.setAttribute('aria-expanded', 'false')
  })
  onBeforeUnmount(() => {
    disposed = true
    document.removeEventListener('click', handleOutsideClick)
    document.removeEventListener('scroll', handleScroll, true)
    window.removeEventListener('resize', placeMenu)
    window.visualViewport?.removeEventListener('resize', placeMenu)
    window.visualViewport?.removeEventListener('scroll', placeMenu)
  })
  defineExpose({ close, dismiss, openAt })
</script>

<template>
  <div ref="rootRef" class="dropdown" @keydown="handleTriggerKeydown">
    <slot name="trigger" :toggle="toggle" :open="open" />
    <Teleport to="body" :disabled="!teleport">
      <Transition name="dropdown">
        <div
          v-if="open"
          ref="menuRef"
          class="dropdown-menu"
          :class="{ 'dropdown-menu-floating': teleport }"
          :style="teleport ? position : undefined"
          role="menu"
          :aria-label="label"
          tabindex="-1"
          @keydown="handleKeydown"
        >
          <div class="dropdown-content">
            <slot :close="close" />
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped lang="scss">
  .dropdown {
    position: relative;
    flex-shrink: 0;
  }
  .dropdown-menu {
    --dropdown-motion-duration: 320ms;
    --dropdown-radius: 20px;
    --dropdown-padding: 6px;
    --dropdown-item-radius: calc(var(--dropdown-radius) - var(--dropdown-padding));
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    width: max-content;
    min-width: 176px;
    padding: var(--dropdown-padding);
    border-radius: var(--dropdown-radius);
    corner-shape: squircle;
    color: var(--text);
    transform-origin: left top;

    // Keep backdrop sampling outside the text's animated filter/opacity layer.
    &::before {
      content: '';
      position: absolute;
      inset: 0;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: inherit;
      corner-shape: inherit;
      background: linear-gradient(145deg, rgba(68, 66, 74, 0.58), rgba(26, 25, 31, 0.52));
      -webkit-backdrop-filter: blur(34px) saturate(170%);
      backdrop-filter: blur(34px) saturate(170%);
      box-shadow:
        0 16px 48px rgba(0, 0, 0, 0.22),
        0 4px 12px rgba(0, 0, 0, 0.1),
        inset 0 1px rgba(255, 255, 255, 0.07);
      pointer-events: none;
    }
  }
  .dropdown-content {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
    border-radius: var(--dropdown-item-radius);
    corner-shape: inherit;
  }
  .dropdown-menu-floating {
    position: fixed;
    z-index: 1000;
    box-sizing: border-box;
    min-width: 0;
    max-width: calc(100vw - 16px);
  }
  .dropdown-enter-active,
  .dropdown-leave-active {
    transition: transform var(--dropdown-motion-duration) cubic-bezier(0.16, 1, 0.3, 1);
    will-change: transform;

    &::before {
      transition: opacity var(--dropdown-motion-duration) cubic-bezier(0.16, 1, 0.3, 1);
    }
    > .dropdown-content {
      transition:
        opacity var(--dropdown-motion-duration) cubic-bezier(0.16, 1, 0.3, 1),
        filter var(--dropdown-motion-duration) cubic-bezier(0.16, 1, 0.3, 1),
        transform var(--dropdown-motion-duration) cubic-bezier(0.16, 1, 0.3, 1);
    }
  }
  .dropdown-leave-active {
    --dropdown-motion-duration: 200ms;
    pointer-events: none;
  }
  .dropdown-enter-from,
  .dropdown-leave-to {
    transform: translateY(-5px) scale(0.96);

    &::before {
      opacity: 0;
    }
    > .dropdown-content {
      opacity: 0;
      filter: blur(5px);
      transform: translateY(-3px);
    }
  }
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .dropdown-menu::before {
      background: rgba(31, 30, 36, 0.97);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dropdown-enter-active,
    .dropdown-leave-active,
    .dropdown-enter-active::before,
    .dropdown-leave-active::before,
    .dropdown-enter-active > .dropdown-content,
    .dropdown-leave-active > .dropdown-content {
      transition: none;
      will-change: auto;
    }
    .dropdown-enter-from,
    .dropdown-leave-to,
    .dropdown-enter-from > .dropdown-content,
    .dropdown-leave-to > .dropdown-content {
      transform: none;
      filter: none;
    }
  }
  @media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
    .dropdown-menu::before {
      background: rgba(26, 25, 31, 0.98);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }
  @media (prefers-contrast: more) {
    .dropdown-menu::before {
      border-color: currentColor;
    }
  }
</style>
