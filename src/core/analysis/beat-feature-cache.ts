/** Bounded, worker-local log-mel frames. The owner scopes a cache to exact PCM and filterbank. */
export interface BeatFeatureCache {
  /** Protect resident pages of the next bounded window before filling its missing frames. */
  prepareRange(startFrame: number, endFrame: number): void
  has(frame: number): boolean
  read(frame: number, target: Float32Array, offset: number): boolean
  write(frame: number, source: Float32Array, offset: number): void
  readonly bytes: number
  readonly peakBytes: number
}

const BANDS = 128
const BLOCK_FRAMES = 64

// A 1500-frame window can straddle 25 blocks when its first frame is unaligned.
export function createBeatFeatureCache(maxBlocks = 25): BeatFeatureCache {
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1) throw new Error('频谱缓存容量无效')
  const blocks = new Map<number, { values: Float32Array; ready: Uint8Array }>()
  const touch = (index: number, block: { values: Float32Array; ready: Uint8Array }): void => {
    blocks.delete(index)
    blocks.set(index, block)
  }
  return {
    prepareRange(startFrame, endFrame) {
      if (
        !Number.isSafeInteger(startFrame) ||
        !Number.isSafeInteger(endFrame) ||
        startFrame < 0 ||
        endFrame < startFrame
      )
        throw new Error('频谱缓存窗口无效')
      if (endFrame === startFrame) return
      const first = Math.floor(startFrame / BLOCK_FRAMES)
      const last = Math.floor((endFrame - 1) / BLOCK_FRAMES)
      if (last - first + 1 > maxBlocks) throw new Error('频谱窗口超过缓存容量')
      // Touch every resident page before writing any missing page. Otherwise a
      // backwards seek could evict the still-useful right edge while filling the left.
      for (let index = first; index <= last; index++) {
        const block = blocks.get(index)
        if (block) touch(index, block)
      }
    },
    has(frame) {
      return blocks.get(Math.floor(frame / BLOCK_FRAMES))?.ready[frame % BLOCK_FRAMES] === 1
    },
    read(frame, target, offset) {
      const index = Math.floor(frame / BLOCK_FRAMES)
      const block = blocks.get(index)
      const local = frame % BLOCK_FRAMES
      if (!block?.ready[local]) return false
      target.set(block.values.subarray(local * BANDS, (local + 1) * BANDS), offset)
      touch(index, block)
      return true
    },
    write(frame, source, offset) {
      const index = Math.floor(frame / BLOCK_FRAMES)
      let block = blocks.get(index)
      if (!block) {
        if (blocks.size >= maxBlocks) {
          const oldest = blocks.keys().next().value!
          block = blocks.get(oldest)!
          blocks.delete(oldest)
          block.ready.fill(0)
        } else {
          block = {
            values: new Float32Array(BLOCK_FRAMES * BANDS),
            ready: new Uint8Array(BLOCK_FRAMES),
          }
        }
      }
      const local = frame % BLOCK_FRAMES
      block.values.set(source.subarray(offset, offset + BANDS), local * BANDS)
      block.ready[local] = 1
      touch(index, block)
    },
    get bytes() {
      return blocks.size * BLOCK_FRAMES * (BANDS * Float32Array.BYTES_PER_ELEMENT + 1)
    },
    get peakBytes() {
      // Pages are recycled in place once full; allocation count never shrinks or overshoots.
      return blocks.size * BLOCK_FRAMES * (BANDS * Float32Array.BYTES_PER_ELEMENT + 1)
    },
  }
}
