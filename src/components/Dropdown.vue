<script setup lang="ts">
  import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

  const open = ref(false)
  const rootRef = ref<HTMLElement | null>(null)
  const menuRef = ref<HTMLElement | null>(null)
  let triggerButton: HTMLElement | null = null

  function getMenuItems(): HTMLElement[] {
    if (!menuRef.value) return []
    return Array.from(
      menuRef.value.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    )
  }

  async function openMenu() {
    if (open.value) return
    open.value = true
    // 焦点进入菜单第一项,菜单项补齐 menuitem 语义
    await nextTick()
    const items = getMenuItems()
    items.forEach((item) => item.setAttribute('role', 'menuitem'))
    items[0]?.focus()
  }

  function closeMenu(options: { restoreFocus?: boolean } = {}) {
    if (!open.value) return
    open.value = false
    if (options.restoreFocus) triggerButton?.focus()
  }

  function toggle() {
    if (open.value) closeMenu()
    else void openMenu()
  }

  function close() {
    // 菜单项点击后关闭,焦点还原到触发按钮(完整菜单模式)
    closeMenu({ restoreFocus: true })
  }

  function handleOutsideClick(event: MouseEvent) {
    if (rootRef.value && !rootRef.value.contains(event.target as Node)) {
      // 点击外部:焦点本来就要移走,不做焦点还原
      closeMenu()
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!open.value) {
      // 触发按钮上 ArrowDown 直接打开并聚焦第一项(按钮自身的 Enter/Space 走 click)
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        void openMenu()
      }
      return
    }

    const items = getMenuItems()
    const currentIndex = items.indexOf(document.activeElement as HTMLElement)

    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu({ restoreFocus: true })
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      items[(currentIndex + 1) % items.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      items[(currentIndex - 1 + items.length) % items.length]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      items[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      items[items.length - 1]?.focus()
    } else if (event.key === 'Tab') {
      // 菜单不是模态:Tab 关闭菜单并让焦点按自然顺序继续前进
      closeMenu()
    }
  }

  watch(open, (isOpen) => {
    triggerButton?.setAttribute('aria-expanded', String(isOpen))
  })

  onMounted(() => {
    document.addEventListener('click', handleOutsideClick)
    triggerButton = rootRef.value?.querySelector<HTMLElement>('button, [role="button"]') ?? null
    triggerButton?.setAttribute('aria-haspopup', 'menu')
    triggerButton?.setAttribute('aria-expanded', 'false')
  })

  onBeforeUnmount(() => document.removeEventListener('click', handleOutsideClick))

  defineExpose({ close })
</script>

<template>
  <div ref="rootRef" class="dropdown" @keydown="handleKeydown">
    <slot name="trigger" :toggle="toggle" :open="open" />
    <Transition name="dropdown">
      <div v-if="open" ref="menuRef" class="dropdown-menu" role="menu" tabindex="-1">
        <slot :close="close" />
      </div>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
  .dropdown {
    position: relative;
    flex-shrink: 0;
  }

  .dropdown-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 50;
    min-width: 120px;
    padding: 5px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    background: rgba(20, 19, 26, 0.96);
    backdrop-filter: blur(22px);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
  }

  .dropdown-enter-active,
  .dropdown-leave-active {
    transition:
      opacity 0.18s cubic-bezier(0.16, 1, 0.3, 1),
      transform 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .dropdown-enter-from,
  .dropdown-leave-to {
    opacity: 0;
    transform: translateY(-4px);
  }
</style>
