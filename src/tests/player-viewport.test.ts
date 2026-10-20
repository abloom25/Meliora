import { describe, expect, it } from 'vitest'
import { calculatePlayerViewport, type PlayerViewportInput } from '../core/layout/player-viewport'

function layout(width: number, height: number, overrides: Partial<PlayerViewportInput> = {}) {
  return calculatePlayerViewport({
    layoutWidth: width,
    layoutHeight: height,
    viewportWidth: width,
    viewportHeight: height,
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...overrides,
  })
}

describe('calculatePlayerViewport', () => {
  it.each([
    [956, 440],
    [956, 600],
    [956, 601],
    [667, 375],
    [800, 600],
    [1920, 580],
  ])(
    'uses compact layout when %i×%i cannot fit the desktop artwork and metadata',
    (width, height) => {
      expect(layout(width, height).compact).toBe(true)
    },
  )

  it.each([
    [956, 700],
    [1280, 720],
    [1440, 900],
    [1920, 1080],
  ])('retains the full layout when %i×%i has enough space', (width, height) => {
    expect(layout(width, height).compact).toBe(false)
  })

  it('responds to width-dependent content needs rather than one height breakpoint', () => {
    expect(layout(800, 650).compact).toBe(false)
    expect(layout(956, 650).compact).toBe(true)
  })

  it('accounts for safe areas and actual browser chrome in the layout budget', () => {
    expect(layout(956, 700).compact).toBe(false)
    expect(layout(956, 700, { viewportHeight: 660 }).compact).toBe(true)
    expect(
      layout(956, 700, { safeAreaInsets: { top: 24, right: 0, bottom: 24, left: 0 } }).compact,
    ).toBe(true)
  })

  it('keeps portrait orientation when opening the keyboard makes the visible area wider than tall', () => {
    const result = layout(440, 956, { viewportHeight: 280 })
    expect(result.compact).toBe(false)
    expect(result.shortLandscape).toBe(false)
    expect(result.minimalPlayer).toBe(false)
  })

  it('scales the artwork continuously and switches to inline metadata only when the stage is full', () => {
    const smaller = layout(956, 439)
    const larger = layout(956, 440)
    expect(smaller.landscapeStageHeight).toBe(323)
    expect(larger.landscapeStageHeight).toBe(324)
    expect(larger.landscapeCoverSize - smaller.landscapeCoverSize).toBe(1)
    expect(layout(956, 273).shortLandscape).toBe(true)
    expect(layout(956, 274).shortLandscape).toBe(false)
  })

  it('limits artwork width to the safe content width on wide but short windows', () => {
    const result = layout(956, 600, {
      safeAreaInsets: { top: 0, right: 62, bottom: 21, left: 62 },
    })
    expect(result.landscapeCoverSize).toBeCloseTo((956 - 62 * 2) * 0.32)
    expect(result.landscapeStageHeight).toBe(471)
  })

  it('uses font metrics when deciding whether the desktop title fits', () => {
    expect(layout(956, 700).compact).toBe(false)
    expect(layout(956, 700, { rootFontSize: 24 }).compact).toBe(true)
  })

  it('does not switch layout on an empty or invalid transitional viewport', () => {
    expect(layout(956, 440, { viewportHeight: 0 }).compact).toBe(false)
    expect(layout(956, 440, { viewportHeight: 0 }).minimalPlayer).toBe(false)
    expect(layout(0, 0).compact).toBe(false)
    expect(layout(956, 440, { viewportHeight: 100 }).landscapeStageHeight).toBe(0)
  })

  it.each([
    [956, 440],
    [667, 375],
    [568, 320],
    [440, 300],
  ])(
    'retains the artwork and controls when compact %i×%i can fit both columns',
    (width, height) => {
      expect(layout(width, height).compact).toBe(true)
      expect(layout(width, height).minimalPlayer).toBe(false)
    },
  )

  it.each([
    [956, 250],
    [480, 240],
    [400, 300],
  ])('uses the minimal player when %i×%i cannot fit compact contents', (width, height) => {
    expect(layout(width, height).compact).toBe(true)
    expect(layout(width, height).minimalPlayer).toBe(true)
  })

  it('accounts for horizontal safe areas and readable lyric width at larger system font sizes', () => {
    expect(layout(568, 320).minimalPlayer).toBe(false)
    expect(
      layout(568, 320, {
        safeAreaInsets: { top: 0, right: 90, bottom: 0, left: 90 },
      }).minimalPlayer,
    ).toBe(true)
    expect(layout(568, 320, { rootFontSize: 24 }).minimalPlayer).toBe(true)
  })

  it('enters the minimal player when only browser chrome reduces the landscape height', () => {
    expect(layout(956, 440).minimalPlayer).toBe(false)
    expect(layout(956, 440, { viewportHeight: 250 }).minimalPlayer).toBe(true)
  })

  it.each([
    { width: 400, height: 240, artwork: false, metadata: false, cover: 0, column: 0 },
    { width: 480, height: 240, artwork: true, metadata: false, cover: 126.4, column: 126.4 },
    { width: 640, height: 240, artwork: true, metadata: true, cover: 164, column: 164 },
    { width: 956, height: 150, artwork: true, metadata: true, cover: 126, column: 298 },
    { width: 956, height: 250, artwork: true, metadata: true, cover: 174, column: 174 },
  ])(
    'restores only the content that fits the minimal player at $width×$height',
    ({ width, height, artwork, metadata, cover, column }) => {
      const result = layout(width, height)
      expect(result.minimalPlayer).toBe(true)
      expect(result.minimalArtworkVisible).toBe(artwork)
      expect(result.minimalMetadataVisible).toBe(metadata)
      expect(result.minimalCoverSize).toBeCloseTo(cover)
      expect(result.minimalArtworkWidth).toBeCloseTo(column)
    },
  )

  it('preserves readable metadata width when height requires a smaller cover', () => {
    const result = layout(956, 180)
    expect(result.minimalMetadataVisible).toBe(true)
    expect(result.minimalMetadataPlacement).toBe('below')
    expect(result.minimalCoverSize).toBe(104)
    expect(result.minimalArtworkWidth).toBe(160)
  })

  it('reserves safe area space before restoring artwork or metadata', () => {
    expect(layout(560, 240).minimalMetadataVisible).toBe(true)
    const narrow = layout(560, 240, {
      safeAreaInsets: { top: 0, right: 62, bottom: 0, left: 62 },
    })
    expect(narrow.minimalArtworkVisible).toBe(true)
    expect(narrow.minimalMetadataVisible).toBe(false)
    expect(narrow.minimalCoverSize).toBeCloseTo(109.6)
    const short = layout(956, 150, {
      safeAreaInsets: { top: 40, right: 62, bottom: 20, left: 62 },
    })
    expect(short.minimalArtworkVisible).toBe(false)
    expect(short.minimalCoverSize).toBe(0)
  })

  it('keeps enough lyric width when the system font size grows', () => {
    const result = layout(560, 240, { rootFontSize: 24 })
    expect(result.minimalPlayer).toBe(true)
    expect(result.minimalArtworkVisible).toBe(false)
    expect(result.minimalMetadataVisible).toBe(false)
    expect(result.minimalMetadataPlacement).toBe('hidden')
  })

  it.each([
    [956, 440],
    [1440, 900],
    [440, 956],
  ])('does not activate minimal artwork outside minimal layout at %i×%i', (width, height) => {
    const result = layout(width, height)
    expect(result.minimalPlayer).toBe(false)
    expect(result.minimalArtworkVisible).toBe(false)
    expect(result.minimalMetadataVisible).toBe(false)
    expect(result.minimalMetadataPlacement).toBe('hidden')
    expect(result.minimalCoverSize).toBe(0)
    expect(result.minimalArtworkWidth).toBe(0)
  })

  it('places metadata beside the artwork only when the low viewport has room for both', () => {
    const beside = layout(956, 150)
    expect(beside.minimalMetadataPlacement).toBe('beside')
    expect(beside.minimalCoverSize).toBe(126)
    expect(beside.minimalArtworkWidth).toBe(126 + 12 + 160)

    const narrower = layout(640, 150)
    expect(narrower.minimalMetadataPlacement).toBe('beside')
    expect(narrower.minimalCoverSize).toBeCloseTo(113.6)
    expect(narrower.minimalArtworkWidth).toBeCloseTo(285.6)

    const insufficient = layout(600, 150)
    expect(insufficient.minimalArtworkVisible).toBe(true)
    expect(insufficient.minimalMetadataPlacement).toBe('hidden')
    expect(insufficient.minimalCoverSize).toBe(126)
  })

  it('retains the below-artwork arrangement when sufficient height is available', () => {
    const result = layout(640, 240)
    expect(result.minimalMetadataPlacement).toBe('below')
    expect(result.minimalCoverSize).toBe(164)
    expect(result.minimalArtworkWidth).toBe(164)
  })

  it('does not take lyric space to preserve beside-artwork metadata after safe areas increase', () => {
    const result = layout(956, 150, {
      safeAreaInsets: { top: 0, right: 200, bottom: 0, left: 200 },
    })
    expect(result.minimalArtworkVisible).toBe(true)
    expect(result.minimalMetadataPlacement).toBe('hidden')
    expect(result.minimalArtworkWidth).toBe(126)
  })
})
