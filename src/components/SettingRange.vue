<script setup lang="ts">
  import { computed, onBeforeUnmount, ref, watch } from 'vue'

  const props = withDefaults(
    defineProps<{
      modelValue: number
      min: number
      max: number
      step?: number
      disabled?: boolean
      ariaLabel?: string
      ariaValueText?: string
    }>(),
    { step: 1, disabled: false, ariaLabel: undefined, ariaValueText: undefined },
  )

  const emit = defineEmits<{
    'update:modelValue': [value: number]
    change: [value: number]
  }>()

  const dragging = ref(false)
  let dragTarget: HTMLElement | null = null
  let dragPointerId: number | null = null

  const normalizedModelValue = computed(() => normalizeValue(props.modelValue))
  const progress = computed(() => {
    const range = props.max - props.min
    if (range <= 0) return 0
    return Math.min(100, Math.max(0, ((normalizedModelValue.value - props.min) / range) * 100))
  })

  function normalizeValue(value: number) {
    if (!Number.isFinite(value)) return props.min
    const clamped = Math.min(props.max, Math.max(props.min, value))
    const steps = Math.round((clamped - props.min) / props.step)
    const stepped = props.min + steps * props.step
    const decimals = String(props.step).split('.')[1]?.length ?? 0
    return Number(Math.min(props.max, Math.max(props.min, stepped)).toFixed(decimals))
  }

  function valueFromPointer(track: HTMLElement, clientX: number) {
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return props.modelValue
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return normalizeValue(props.min + ratio * (props.max - props.min))
  }

  function updateValue(value: number) {
    if (props.disabled) return
    emit('update:modelValue', normalizeValue(value))
  }

  function releasePointerCapture() {
    if (dragTarget && dragPointerId !== null) {
      dragTarget.releasePointerCapture?.(dragPointerId)
    }
    dragTarget = null
    dragPointerId = null
  }

  function removeGlobalDragListeners() {
    window.removeEventListener('pointerup', handleWindowPointerUp)
    window.removeEventListener('pointercancel', handleWindowPointerCancel)
    window.removeEventListener('blur', handleWindowBlur)
  }

  function isActivePointer(event: PointerEvent) {
    return dragPointerId === null || event.pointerId === dragPointerId
  }

  function finishDrag(value: number, options: { emitChange: boolean }) {
    if (!dragging.value) return
    dragging.value = false
    releasePointerCapture()
    removeGlobalDragListeners()
    const normalized = normalizeValue(value)
    if (!props.disabled) emit('update:modelValue', normalized)
    if (options.emitChange) emit('change', normalized)
  }

  function cancelDragWithCurrentValue() {
    finishDrag(props.modelValue, { emitChange: true })
  }

  function handleWindowPointerUp(event: PointerEvent) {
    if (!dragging.value || !dragTarget) return
    if (!isActivePointer(event)) return
    finishDrag(valueFromPointer(dragTarget, event.clientX), { emitChange: true })
  }

  function handleWindowPointerCancel(event: PointerEvent) {
    if (!isActivePointer(event)) return
    cancelDragWithCurrentValue()
  }

  function handleWindowBlur() {
    cancelDragWithCurrentValue()
  }

  function beginDrag(event: PointerEvent) {
    if (props.disabled) return
    if (dragging.value && !isActivePointer(event)) return
    const track = event.currentTarget as HTMLElement
    dragging.value = true
    dragTarget = track
    dragPointerId = event.pointerId
    track.setPointerCapture?.(event.pointerId)
    window.addEventListener('pointerup', handleWindowPointerUp)
    window.addEventListener('pointercancel', handleWindowPointerCancel)
    window.addEventListener('blur', handleWindowBlur)
    updateValue(valueFromPointer(track, event.clientX))
  }

  function moveDrag(event: PointerEvent) {
    if (!dragging.value || props.disabled) return
    if (!isActivePointer(event)) return
    updateValue(valueFromPointer(event.currentTarget as HTMLElement, event.clientX))
  }

  function commitDrag(event: PointerEvent) {
    if (!dragging.value) return
    if (!isActivePointer(event)) return
    const track = event.currentTarget as HTMLElement
    finishDrag(valueFromPointer(track, event.clientX), { emitChange: true })
  }

  function cancelDrag(event: PointerEvent) {
    if (!isActivePointer(event)) return
    cancelDragWithCurrentValue()
  }

  function handleKeydown(event: KeyboardEvent) {
    if (props.disabled) return
    const largeStep = props.step * 10
    let value: number | null = null
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      value = props.modelValue - props.step
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      value = props.modelValue + props.step
    } else if (event.key === 'PageDown') {
      value = props.modelValue - largeStep
    } else if (event.key === 'PageUp') {
      value = props.modelValue + largeStep
    } else if (event.key === 'Home') {
      value = props.min
    } else if (event.key === 'End') {
      value = props.max
    }
    if (value === null) return
    event.preventDefault()
    const normalized = normalizeValue(value)
    updateValue(normalized)
    emit('change', normalized)
  }

  watch(
    () => props.disabled,
    (disabled) => {
      if (disabled && dragging.value) cancelDragWithCurrentValue()
    },
  )

  onBeforeUnmount(() => {
    if (dragging.value) cancelDragWithCurrentValue()
    removeGlobalDragListeners()
  })
</script>

<template>
  <div
    class="setting-range"
    :class="{ 'is-disabled': disabled, 'is-dragging': dragging }"
    role="slider"
    :tabindex="disabled ? -1 : 0"
    :aria-label="ariaLabel"
    :aria-disabled="disabled ? 'true' : undefined"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="normalizedModelValue"
    :aria-valuetext="ariaValueText"
    :style="{ '--setting-progress': `${progress}%` }"
    @pointerdown="beginDrag"
    @pointermove="moveDrag"
    @pointerup="commitDrag"
    @pointercancel="cancelDrag"
    @keydown="handleKeydown"
  >
    <span class="setting-range-fill" aria-hidden="true" />
  </div>
</template>

<style scoped lang="scss">
  .setting-range {
    position: relative;
    display: block;
    width: 100%;
    height: 28px;
    margin-top: 12px;
    padding: 0;
    border-radius: 99px;
    background: transparent;
    cursor: pointer;
    touch-action: none;
    -webkit-tap-highlight-color: transparent;
  }

  .setting-range::before,
  .setting-range-fill {
    position: absolute;
    top: 50%;
    left: 0;
    height: 7px;
    border-radius: 99px;
    transform: translateY(-50%);
  }

  .setting-range::before {
    content: '';
    right: 0;
    background: rgba(255, 255, 255, 0.18);
  }

  .setting-range-fill {
    width: var(--setting-progress);
    border-radius: 99px 0 0 99px;
    background: rgba(255, 255, 255, 0.88);
  }

  .setting-range:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  .setting-range.is-disabled {
    opacity: 0.4;
    cursor: default;
  }

  @media (pointer: coarse) {
    .setting-range {
      height: 40px;
    }
  }
</style>
