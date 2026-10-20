/** DOM 渲染适配器：宿主选择目标，分析器只传递数值，高频写入不经过 Vue。 */
export interface BeatVisualTargets {
  getBeatTargets?: () => readonly (HTMLElement | null | undefined)[]
  getSpectrumTargets?: () => readonly (HTMLElement | null | undefined)[]
}

export function createBeatVisualRenderer(targets: BeatVisualTargets) {
  // 按节点去重，避免主节点不变时遗漏新挂载的第二个目标；WeakMap 不保留已卸载节点。
  const beatValues = new WeakMap<HTMLElement, string>()
  const spectrumValues = new WeakMap<HTMLElement, string>()

  function renderBeat(level: number, sustain: number): void {
    const nextLevel = level.toFixed(3)
    const nextSustain = sustain.toFixed(3)
    const next = `${nextLevel}/${nextSustain}`
    for (const el of targets.getBeatTargets?.() ?? []) {
      if (!el) continue
      if (!el.isConnected) {
        beatValues.delete(el)
        continue
      }
      if (beatValues.get(el) === next) continue
      el.style.setProperty('--beat-level', nextLevel)
      el.style.setProperty('--beat-sustain', nextSustain)
      beatValues.set(el, next)
    }
  }

  function renderSpectrum(levels: readonly number[]): void {
    const values = levels.map(
      (level) => `${(Math.max(0.08, Math.min(1, level)) * 100).toFixed(1)}%`,
    )
    const next = values.join('/')
    for (const el of targets.getSpectrumTargets?.() ?? []) {
      if (!el) continue
      if (!el.isConnected) {
        spectrumValues.delete(el)
        continue
      }
      if (spectrumValues.get(el) === next) continue
      values.forEach((value, index) => el.style.setProperty(`--spectrum-level-${index}`, value))
      spectrumValues.set(el, next)
    }
  }

  return { renderBeat, renderSpectrum }
}
