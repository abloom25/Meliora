export interface PlayerSafeAreaInsets {
  top: number
  right: number
  bottom: number
  left: number
}

export interface PlayerViewportInput {
  layoutWidth: number
  layoutHeight: number
  viewportWidth: number
  viewportHeight: number
  safeAreaInsets: PlayerSafeAreaInsets
  rootFontSize?: number
}

export type MinimalMetadataPlacement = 'hidden' | 'below' | 'beside'

export const MOBILE_SHEET_MAX_WIDTH = 720

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

/**
 * 先确认布局视口的方向,再判断可视区域能否放下桌面双栏内容。
 * 键盘只压缩 visual viewport 时不会把竖屏变成横屏；安全区与工具栏会参与空间预算。
 */
export function calculatePlayerViewport(input: PlayerViewportInput) {
  const { layoutWidth, layoutHeight, viewportWidth, viewportHeight, safeAreaInsets } = input
  const rootFontSize = input.rootFontSize ?? 16
  const validViewport =
    layoutWidth > 0 && layoutHeight > 0 && viewportWidth > 0 && viewportHeight > 0
  const landscape = validViewport && layoutWidth > layoutHeight
  const desktopSide = viewportWidth <= 980 ? 42 : clamp(viewportWidth * 0.08, 48, 150)
  const desktopGap = viewportWidth <= 980 ? 44 : clamp(viewportWidth * 0.07, 48, 120)
  const desktopContentWidth = Math.max(
    0,
    viewportWidth -
      Math.max(desktopSide, safeAreaInsets.left) -
      Math.max(desktopSide, safeAreaInsets.right) -
      desktopGap,
  )
  const desktopArtworkWidth = Math.min(
    desktopContentWidth * 0.44,
    viewportWidth <= 980 ? viewportWidth * 0.44 : Math.min(layoutHeight * 0.52, 520),
  )
  // 对应桌面封面下的间距、单行标题、歌手；为标题保留一行即可，长标题仍由视图换行。
  const desktopTitleSize = clamp(viewportWidth * 0.022, rootFontSize * 1.44, rootFontSize * 2)
  const desktopMetadataHeight = 28 + desktopTitleSize * 1.16 + 12 + rootFontSize * 0.92 * 1.35
  // 桌面布局顶部 78px、底部播放器 126px、舞台下间距 24px。
  const desktopStageHeight = Math.max(
    0,
    viewportHeight - 78 - 126 - 24 - safeAreaInsets.top - safeAreaInsets.bottom,
  )
  const compact =
    landscape &&
    (layoutWidth <= MOBILE_SHEET_MAX_WIDTH ||
      desktopStageHeight < desktopArtworkWidth + desktopMetadataHeight)

  // 紧凑布局固定保留完整触控空间：顶部和底部控件各 48px，舞台下间距 12px。
  const landscapeStageHeight = Math.max(
    0,
    viewportHeight - safeAreaInsets.top - 48 - 48 - 12 - Math.max(8, safeAreaInsets.bottom),
  )
  const landscapeMetadataHeight = 62
  const minimumStackedCover = 96
  const landscapeContentWidth = Math.max(
    0,
    viewportWidth - Math.max(16, safeAreaInsets.left) - Math.max(16, safeAreaInsets.right),
  )
  const landscapeCoverSize = clamp(
    landscapeStageHeight - landscapeMetadataHeight,
    48,
    Math.min(380, landscapeContentWidth * 0.32),
  )
  const shortLandscape =
    compact && landscapeStageHeight < minimumStackedCover + landscapeMetadataHeight
  // 双栏仍需留出可辨认的封面和约 15rem 的歌词行宽；不足时让出封面与上下控制栏。
  const landscapeColumnGap = clamp(viewportWidth * 0.04, 24, 48)
  const landscapeArtworkColumnWidth = Math.min(
    landscapeContentWidth * 0.34,
    landscapeCoverSize + 32,
  )
  const landscapeLyricsWidth =
    landscapeContentWidth - landscapeArtworkColumnWidth - landscapeColumnGap
  const minimalPlayer =
    compact &&
    (shortLandscape ||
      landscapeArtworkColumnWidth < minimumStackedCover ||
      landscapeLyricsWidth < rootFontSize * 15)
  // 极简布局仍先保证歌词和播放按钮；宽度有余量时恢复封面，再选择歌曲信息的位置。
  const minimalContentHeight = Math.max(
    0,
    viewportHeight - Math.max(12, safeAreaInsets.top) - Math.max(12, safeAreaInsets.bottom),
  )
  const minimalControlSize = clamp(viewportHeight * 0.22, 44, 56)
  const minimalColumnGap = clamp(viewportWidth * 0.03, 12, 28)
  const minimalArtworkBudget = Math.max(
    0,
    landscapeContentWidth - rootFontSize * 15 - minimalControlSize - minimalColumnGap * 2,
  )
  const minimalMetadataHeight = Math.max(52, rootFontSize * 3.25)
  const minimalMetadataWidth = Math.max(160, rootFontSize * 10)
  const minimalArtworkVisible =
    minimalPlayer &&
    minimalArtworkBudget >= minimumStackedCover &&
    minimalContentHeight >= minimumStackedCover
  const metadataBelowFits =
    minimalArtworkVisible &&
    minimalArtworkBudget >= minimalMetadataWidth &&
    minimalContentHeight >= minimumStackedCover + minimalMetadataHeight
  const metadataBesideGap = 12
  const metadataBesideFits =
    minimalArtworkVisible &&
    minimalArtworkBudget >= minimumStackedCover + metadataBesideGap + minimalMetadataWidth &&
    minimalContentHeight >= minimalMetadataHeight
  const minimalMetadataPlacement: MinimalMetadataPlacement = metadataBelowFits
    ? 'below'
    : metadataBesideFits
      ? 'beside'
      : 'hidden'
  const minimalMetadataVisible = minimalMetadataPlacement !== 'hidden'
  const minimalCoverSize = minimalArtworkVisible
    ? Math.min(
        240,
        minimalArtworkBudget -
          (minimalMetadataPlacement === 'beside' ? metadataBesideGap + minimalMetadataWidth : 0),
        minimalContentHeight - (minimalMetadataPlacement === 'below' ? minimalMetadataHeight : 0),
      )
    : 0
  const minimalArtworkWidth = minimalArtworkVisible
    ? minimalMetadataPlacement === 'beside'
      ? minimalCoverSize + metadataBesideGap + minimalMetadataWidth
      : Math.max(minimalCoverSize, minimalMetadataVisible ? minimalMetadataWidth : 0)
    : 0

  return {
    compact,
    shortLandscape,
    minimalPlayer,
    minimalArtworkVisible,
    minimalMetadataVisible,
    minimalMetadataPlacement,
    minimalCoverSize,
    minimalArtworkWidth,
    landscapeStageHeight,
    landscapeCoverSize,
  }
}
