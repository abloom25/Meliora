<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 22 })
</script>

<template>
  <svg
    class="brand-mark"
    :width="size"
    :height="size"
    viewBox="0 0 64 64"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M10 44V20c0-4 5-5.8 7.5-2.7L32 35.5l14.5-18.2C49 14.2 54 16 54 20v24"
      stroke="currentColor"
      stroke-width="8"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <circle cx="10" cy="47" r="7" fill="currentColor" />
    <circle cx="54" cy="47" r="7" fill="currentColor" />
  </svg>
</template>
