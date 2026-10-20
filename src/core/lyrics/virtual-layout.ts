/** Prefix sums keep variable-height lyric layout queries independent of song length. */
export class VirtualLyricLayout {
  readonly count: number
  private tree: Float64Array
  private sizes: Float64Array
  private extents: Float64Array
  private gaps: Float64Array

  constructor(count: number) {
    this.count = count
    this.tree = new Float64Array(count + 1)
    this.sizes = new Float64Array(count)
    this.extents = new Float64Array(count)
    this.gaps = new Float64Array(count)
  }

  set(index: number, height: number, gap: number, open = 1): void {
    if (index < 0 || index >= this.count) return
    const amount = Math.max(0, Math.min(1, open))
    const size = Math.max(0, height) * amount
    const space = Math.max(0, gap) * amount
    const extent = size + space
    const delta = extent - this.extents[index]!
    this.sizes[index] = size
    this.gaps[index] = space
    this.extents[index] = extent
    if (delta === 0) return
    for (let cursor = index + 1; cursor <= this.count; cursor += cursor & -cursor) {
      this.tree[cursor] = this.tree[cursor]! + delta
    }
  }

  private prefix(end: number): number {
    let sum = 0
    for (let cursor = end; cursor > 0; cursor -= cursor & -cursor) sum += this.tree[cursor]!
    return sum
  }

  /** First extent ending after the given unadjusted coordinate; skips collapsed rows. */
  private after(value: number): number {
    let index = 0
    let sum = 0
    let step = 1
    while (step * 2 <= this.count) step *= 2
    for (; step >= 1; step = Math.floor(step / 2)) {
      const next = index + step
      if (next <= this.count && sum + this.tree[next]! <= value) {
        index = next
        sum += this.tree[next]!
      }
    }
    return index
  }

  private leadingGap(): number {
    return this.gaps[this.after(0)] ?? 0
  }

  height(index: number): number {
    return this.sizes[index] ?? 0
  }

  top(index: number): number {
    if (index < 0 || index >= this.count) return 0
    return Math.max(0, this.prefix(index) + this.gaps[index]! - this.leadingGap())
  }

  focus(index: number, viewportHeight: number, ratio: number): number {
    const target = index >= 0 && index < this.count ? index : 0
    return this.top(target) + this.height(target) / 2 - viewportHeight * ratio
  }

  /** Only visits rows intersecting the window, even across thousands of collapsed harmonies. */
  window(from: number, until: number): number[] {
    const indices: number[] = []
    const leading = this.leadingGap()
    let index = this.after(Math.max(0, from + leading))
    while (index < this.count) {
      if (this.top(index) >= until) break
      if (this.height(index) > 0) indices.push(index)
      index = this.after(this.prefix(index + 1) + 0.000001)
    }
    return indices
  }
}
