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

const themeCache = new Map<string, ThemeColor | null>()
const PALETTE_BUCKET_SIZE = 28

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
  const { hue, saturation } = rgbToHsl(color)
  const resolvedSaturation = Math.max(0.32, Math.min(0.56, saturation * 0.82))
  const accent = hslToRgb(hue, resolvedSaturation, 0.62)
  const soft = hslToRgb(hue, Math.max(0.24, resolvedSaturation * 0.68), 0.75)
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

export function extractThemeColor(image: HTMLImageElement): ThemeColor | null {
  const canvas = document.createElement('canvas')
  canvas.width = 48
  canvas.height = 48
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null

  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    const palette = new Map<string, { color: RGB, count: number, saturation: number, lightness: number }>()

    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3] ?? 0
      if (alpha < 180) continue
      const color = {
        r: pixels[index] ?? 0,
        g: pixels[index + 1] ?? 0,
        b: pixels[index + 2] ?? 0,
      }
      const { saturation, lightness } = rgbToHsl(color)
      if (lightness < 0.16 || lightness > 0.9 || saturation < 0.12) continue

      const key = colorBucketKey(color)
      const bucket = palette.get(key)
      if (bucket) {
        bucket.color.r += color.r
        bucket.color.g += color.g
        bucket.color.b += color.b
        bucket.count += 1
        bucket.saturation += saturation
        bucket.lightness += lightness
      } else {
        palette.set(key, {
          color: { ...color },
          count: 1,
          saturation,
          lightness,
        })
      }
    }

    let best: RGB | null = null
    let bestScore = -1
    const total = [...palette.values()].reduce((sum, bucket) => sum + bucket.count, 0)

    for (const bucket of palette.values()) {
      const color = {
        r: Math.round(bucket.color.r / bucket.count),
        g: Math.round(bucket.color.g / bucket.count),
        b: Math.round(bucket.color.b / bucket.count),
      }
      const saturation = bucket.saturation / bucket.count
      const lightness = bucket.lightness / bucket.count
      const coverage = total ? bucket.count / total : 0
      const score = Math.sqrt(coverage) * 2.2
        + Math.min(saturation, 0.72) * 0.85
        + (1 - Math.abs(lightness - 0.5)) * 0.65
      if (score > bestScore) {
        best = color
        bestScore = score
      }
    }
    return best ? createThemeColor(best) : null
  } catch {
    return null
  }
}

export function loadThemeColor(url: string): Promise<ThemeColor | null> {
  if (themeCache.has(url)) return Promise.resolve(themeCache.get(url) ?? null)
  return new Promise((resolve) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      const theme = extractThemeColor(image)
      themeCache.set(url, theme)
      resolve(theme)
    }
    image.onerror = () => {
      themeCache.set(url, null)
      resolve(null)
    }
    image.src = url
  })
}
