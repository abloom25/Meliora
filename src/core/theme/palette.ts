/**
 * 主题色提取的纯算法实现：从 Uint8ClampedArray (RGBA) 提取主题色。
 * 不依赖任何 DOM API（Image / canvas），可在 Worker 中运行，也可在主线程兜底使用。
 */

export interface ThemeColor {
  accent: string
  accentSoft: string
  rgb: string
}

interface RGB {
  r: number
  g: number
  b: number
}

const PALETTE_BUCKET_SIZE = 24

function rgbToHsl({ r, g, b }: RGB) {
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  let hue = 0

  if (delta) {
    if (max === red) hue = ((green - blue) / delta) % 6
    else if (max === green) hue = (blue - red) / delta + 2
    else hue = (red - green) / delta + 4
    hue = Math.round(hue * 60)
    if (hue < 0) hue += 360
  }

  const lightness = (max + min) / 2
  const saturation = delta ? delta / (1 - Math.abs(2 * lightness - 1)) : 0
  return { hue, saturation, lightness }
}

function hslToRgb(hue: number, saturation: number, lightness: number): RGB {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const segment = hue / 60
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1))
  let red = 0
  let green = 0
  let blue = 0

  if (segment < 1) [red, green] = [chroma, secondary]
  else if (segment < 2) [red, green] = [secondary, chroma]
  else if (segment < 3) [green, blue] = [chroma, secondary]
  else if (segment < 4) [green, blue] = [secondary, chroma]
  else if (segment < 5) [red, blue] = [secondary, chroma]
  else [red, blue] = [chroma, secondary]

  const match = lightness - chroma / 2
  return {
    r: Math.round((red + match) * 255),
    g: Math.round((green + match) * 255),
    b: Math.round((blue + match) * 255),
  }
}

export function createThemeColor(color: RGB): ThemeColor {
  const { hue, saturation, lightness } = rgbToHsl(color)
  const resolvedSaturation = Math.max(0.28, Math.min(0.52, saturation * 0.76 + 0.08))
  const resolvedLightness = Math.max(0.54, Math.min(0.66, 0.6 + (0.48 - lightness) * 0.16))
  const accent = hslToRgb(hue, resolvedSaturation, resolvedLightness)
  const soft = hslToRgb(
    hue,
    Math.max(0.2, resolvedSaturation * 0.62),
    Math.min(0.78, resolvedLightness + 0.13),
  )
  return {
    accent: `rgb(${accent.r} ${accent.g} ${accent.b})`,
    accentSoft: `rgb(${soft.r} ${soft.g} ${soft.b})`,
    rgb: `${accent.r}, ${accent.g}, ${accent.b}`,
  }
}

function colorBucketKey({ r, g, b }: RGB) {
  return [
    Math.round(r / PALETTE_BUCKET_SIZE),
    Math.round(g / PALETTE_BUCKET_SIZE),
    Math.round(b / PALETTE_BUCKET_SIZE),
  ].join(':')
}

function relativeLuminance({ r, g, b }: RGB) {
  const channel = (value: number) => {
    const normalized = value / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return channel(r) * 0.2126 + channel(g) * 0.7152 + channel(b) * 0.0722
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function colorDistance(first: RGB, second: RGB) {
  const redMean = (first.r + second.r) / 2
  const red = first.r - second.r
  const green = first.g - second.g
  const blue = first.b - second.b
  return Math.sqrt(
    (2 + redMean / 256) * red * red + 4 * green * green + (2 + (255 - redMean) / 256) * blue * blue,
  )
}

/**
 * 从 ImageData 风格的像素数据（RGBA, Uint8ClampedArray）提取主题色。
 * width / height 用于像素位置加权（中心区域更重要）。
 */
export function extractThemeColorFromPixels(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): ThemeColor | null {
  const palette = new Map<
    string,
    {
      color: RGB
      count: number
      saturation: number
      lightness: number
      luminance: number
      weight: number
    }
  >()

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3] ?? 0
    if (alpha < 180) continue
    const pixelIndex = index / 4
    const x = pixelIndex % width
    const y = Math.floor(pixelIndex / width)
    const color = {
      r: pixels[index] ?? 0,
      g: pixels[index + 1] ?? 0,
      b: pixels[index + 2] ?? 0,
    }
    const { saturation, lightness } = rgbToHsl(color)
    const luminance = relativeLuminance(color)
    if (lightness < 0.12 || lightness > 0.88 || saturation < 0.08) continue

    const centerX = Math.abs((x + 0.5) / width - 0.5) * 2
    const centerY = Math.abs((y + 0.5) / height - 0.5) * 2
    const centerWeight = 1 - clamp((centerX * centerX + centerY * centerY) / 1.7, 0, 0.58)
    const lightnessWeight = 1 - clamp(Math.abs(lightness - 0.48) / 0.42, 0, 0.78)
    const saturationWeight = clamp(saturation, 0.16, 0.68)
    const luminanceWeight = 1 - clamp(Math.abs(luminance - 0.28) / 0.34, 0, 0.72)
    const weight =
      centerWeight *
      (0.48 + lightnessWeight * 0.52) *
      (0.54 + saturationWeight * 0.78) *
      (0.64 + luminanceWeight * 0.36)

    const key = colorBucketKey(color)
    const bucket = palette.get(key)
    if (bucket) {
      bucket.color.r += color.r * weight
      bucket.color.g += color.g * weight
      bucket.color.b += color.b * weight
      bucket.count += 1
      bucket.saturation += saturation
      bucket.lightness += lightness
      bucket.luminance += luminance
      bucket.weight += weight
    } else {
      palette.set(key, {
        color: { r: color.r * weight, g: color.g * weight, b: color.b * weight },
        count: 1,
        saturation,
        lightness,
        luminance,
        weight,
      })
    }
  }

  let best: RGB | null = null
  let bestScore = -1
  const buckets = [...palette.values()]
  const totalWeight = buckets.reduce((sum, bucket) => sum + bucket.weight, 0)
  const average = buckets.reduce<RGB>(
    (sum, bucket) => ({
      r: sum.r + bucket.color.r,
      g: sum.g + bucket.color.g,
      b: sum.b + bucket.color.b,
    }),
    { r: 0, g: 0, b: 0 },
  )
  if (totalWeight) {
    average.r /= totalWeight
    average.g /= totalWeight
    average.b /= totalWeight
  }

  for (const bucket of buckets) {
    if (!bucket.weight) continue
    const color = {
      r: Math.round(bucket.color.r / bucket.weight),
      g: Math.round(bucket.color.g / bucket.weight),
      b: Math.round(bucket.color.b / bucket.weight),
    }
    const saturation = bucket.saturation / bucket.count
    const lightness = bucket.lightness / bucket.count
    const luminance = bucket.luminance / bucket.count
    const coverage = totalWeight ? bucket.weight / totalWeight : 0
    const distinctness = totalWeight ? clamp(colorDistance(color, average) / 180, 0, 1) : 0
    const score =
      Math.sqrt(coverage) * 1.7 +
      Math.min(saturation, 0.7) * 0.95 +
      (1 - Math.abs(lightness - 0.48)) * 0.72 +
      (1 - Math.abs(luminance - 0.28)) * 0.42 +
      distinctness * 0.26
    if (score > bestScore) {
      best = color
      bestScore = score
    }
  }
  return best ? createThemeColor(best) : null
}
