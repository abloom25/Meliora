import { ref } from 'vue'
import type { ThemeColor } from '../utils/theme'
import { isReducedMotion } from '../utils/motion'

const DEFAULT_ACCENT = '#81d8d0'
const DEFAULT_ACCENT_SOFT = '#a7e7e2'
const DEFAULT_ACCENT_RGB = '129, 216, 208'

// 检测浏览器是否支持 CSS @property 注册（Chrome 85+ / Safari 16.4+）
// 若支持，则由 CSS 原生处理颜色过渡，避免 JS requestAnimationFrame 每帧更新 ref
const supportsCssProperty = typeof CSS !== 'undefined' && 'registerProperty' in CSS

function rgbToHex(r: number, g: number, b: number) {
  const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

export function useThemeAccent() {
  const accent = ref(DEFAULT_ACCENT)
  const accentSoft = ref(DEFAULT_ACCENT_SOFT)
  const accentRgb = ref(DEFAULT_ACCENT_RGB)

  let themeFrame = 0

  function parseColor(value: string): [number, number, number] {
    if (value.startsWith('#')) {
      const hex = value.slice(1)
      const normalized =
        hex.length === 3
          ? hex
              .split('')
              .map((part) => part + part)
              .join('')
          : hex
      return [
        Number.parseInt(normalized.slice(0, 2), 16),
        Number.parseInt(normalized.slice(2, 4), 16),
        Number.parseInt(normalized.slice(4, 6), 16),
      ]
    }

    const channels = value.match(/\d+(\.\d+)?/g)?.map(Number) ?? [129, 216, 208]
    return [channels[0] ?? 129, channels[1] ?? 216, channels[2] ?? 208]
  }

  function formatRgb([red, green, blue]: [number, number, number]) {
    return `rgb(${Math.round(red)} ${Math.round(green)} ${Math.round(blue)})`
  }

  function setThemeColors(
    nextAccent: [number, number, number],
    nextSoft: [number, number, number],
  ) {
    accent.value = formatRgb(nextAccent)
    accentSoft.value = formatRgb(nextSoft)
    accentRgb.value = `${Math.round(nextAccent[0])}, ${Math.round(nextAccent[1])}, ${Math.round(nextAccent[2])}`
  }

  function applyThemeViaCss(theme: ThemeColor) {
    // 使用 hex 格式以确保 CSS @property 过渡行为一致
    const [ar, ag, ab] = parseColor(theme.accent)
    const [sr, sg, sb] = parseColor(theme.accentSoft)
    const hexAccent = rgbToHex(ar, ag, ab)
    const hexSoft = rgbToHex(sr, sg, sb)
    accent.value = hexAccent
    accentSoft.value = hexSoft
    accentRgb.value = `${ar}, ${ag}, ${ab}`
    document.documentElement.style.setProperty('--accent', hexAccent)
    document.documentElement.style.setProperty('--accent-soft', hexSoft)
  }

  function mixChannel(from: number, to: number, progress: number) {
    return from + (to - from) * progress
  }

  function applyTheme(theme: ThemeColor) {
    window.cancelAnimationFrame(themeFrame)
    if (isReducedMotion()) {
      setThemeColors(parseColor(theme.accent), parseColor(theme.accentSoft))
      return
    }
    // 有 @property 支持时，CSS 原生过渡，无需 JS 动画
    if (supportsCssProperty) {
      applyThemeViaCss(theme)
      return
    }
    const fromAccent = parseColor(accent.value)
    const fromSoft = parseColor(accentSoft.value)
    const toAccent = parseColor(theme.accent)
    const toSoft = parseColor(theme.accentSoft)
    const startedAt = performance.now()
    const duration = 720

    const step = (now: number) => {
      const rawProgress = Math.min(1, (now - startedAt) / duration)
      const progress = 1 - (1 - rawProgress) ** 3
      setThemeColors(
        [
          mixChannel(fromAccent[0], toAccent[0], progress),
          mixChannel(fromAccent[1], toAccent[1], progress),
          mixChannel(fromAccent[2], toAccent[2], progress),
        ],
        [
          mixChannel(fromSoft[0], toSoft[0], progress),
          mixChannel(fromSoft[1], toSoft[1], progress),
          mixChannel(fromSoft[2], toSoft[2], progress),
        ],
      )
      if (rawProgress < 1) themeFrame = window.requestAnimationFrame(step)
    }

    themeFrame = window.requestAnimationFrame(step)
  }

  function resetTheme() {
    applyTheme({
      accent: DEFAULT_ACCENT,
      accentSoft: DEFAULT_ACCENT_SOFT,
      rgb: DEFAULT_ACCENT_RGB,
    })
  }

  return {
    accent,
    accentSoft,
    accentRgb,
    applyTheme,
    resetTheme,
  }
}
