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
  const accent = hslToRgb(hue, Math.max(0.58, saturation), 0.62)
  const soft = hslToRgb(hue, Math.max(0.42, saturation * 0.78), 0.74)
  return {
    accent: `rgb(${accent.r} ${accent.g} ${accent.b})`,
    accentSoft: `rgb(${soft.r} ${soft.g} ${soft.b})`,
    rgb: `${accent.r}, ${accent.g}, ${accent.b}`,
  }
}

export function extractThemeColor(image: HTMLImageElement): ThemeColor | null {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null

  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let best: RGB | null = null
    let bestScore = -1

    for (let index = 0; index < pixels.length; index += 16) {
      const alpha = pixels[index + 3] ?? 0
      if (alpha < 180) continue
      const color = {
        r: pixels[index] ?? 0,
        g: pixels[index + 1] ?? 0,
        b: pixels[index + 2] ?? 0,
      }
      const { saturation, lightness } = rgbToHsl(color)
      if (lightness < 0.16 || lightness > 0.88 || saturation < 0.16) continue
      const score = saturation * 1.45 + (1 - Math.abs(lightness - 0.52)) * 0.7
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
