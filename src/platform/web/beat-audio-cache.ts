export interface BeatAudioData {
  channels: Float32Array<ArrayBuffer>[]
  sampleRate: number
}

export interface BeatAudioCache {
  /** Removes the entry: its buffers may now be transferred to a worker. */
  takePcm(source: string): BeatAudioData | undefined
  putPcm(source: string, audio: BeatAudioData): void
  /** Returns a decoder-owned copy; decodeAudioData can detach its input. */
  readEncoded(source: string): ArrayBuffer | undefined
  putEncoded(source: string, encoded: ArrayBuffer): void
  delete(source: string): void
  clear(): void
  readonly pcmBytes: number
  readonly encodedBytes: number
  readonly pcmEntries: number
  readonly encodedEntries: number
}

interface Entry<T> {
  value: T
  bytes: number
}

function pcmBytes(audio: BeatAudioData): number {
  const length = audio.channels[0]?.length ?? 0
  if (
    !Number.isFinite(audio.sampleRate) ||
    audio.sampleRate < 8000 ||
    audio.sampleRate > 192000 ||
    !length ||
    !audio.channels.length ||
    audio.channels.length > 8 ||
    audio.channels.some(
      (channel) =>
        !ArrayBuffer.isView(channel) ||
        Object.prototype.toString.call(channel) !== '[object Float32Array]' ||
        Object.prototype.toString.call(channel.buffer) !== '[object ArrayBuffer]' ||
        channel.length !== length ||
        channel.byteLength === 0,
    )
  )
    return 0
  // Views can share a larger backing allocation. Count that retained memory once.
  return [...new Set(audio.channels.map((channel) => channel.buffer))].reduce(
    (bytes, buffer) => bytes + buffer.byteLength,
    0,
  )
}

/** Resident audio only; model sessions and the single in-flight PCM are never retained here. */
export function createBeatAudioCache(
  options: { maxPcmBytes?: number; maxEncodedBytes?: number; maxEntries?: number } = {},
): BeatAudioCache {
  const maximumPcm = options.maxPcmBytes ?? 96 * 1024 * 1024
  const maximumEncoded = options.maxEncodedBytes ?? 32 * 1024 * 1024
  const maximumEntries = options.maxEntries ?? 3
  if (
    [maximumPcm, maximumEncoded, maximumEntries].some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  )
    throw new Error('音频缓存容量无效')
  const pcm = new Map<string, Entry<BeatAudioData>>()
  const encoded = new Map<string, Entry<ArrayBuffer>>()
  const bytesIn = <T>(entries: Map<string, Entry<T>>): number =>
    [...entries.values()].reduce((total, entry) => total + entry.bytes, 0)
  const insert = <T>(
    entries: Map<string, Entry<T>>,
    source: string,
    value: T,
    bytes: number,
    maximum: number,
  ): void => {
    if (!source || !bytes || bytes > maximum || maximumEntries === 0) return
    entries.delete(source)
    while (entries.size >= maximumEntries || bytesIn(entries) + bytes > maximum) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
    entries.set(source, { value, bytes })
  }
  return {
    takePcm(source): BeatAudioData | undefined {
      const entry = pcm.get(source)
      pcm.delete(source)
      if (!entry || !pcmBytes(entry.value)) return undefined
      return entry.value
    },
    putPcm(source, audio): void {
      insert(
        pcm,
        source,
        { channels: [...audio.channels], sampleRate: audio.sampleRate },
        pcmBytes(audio),
        maximumPcm,
      )
    },
    readEncoded(source): ArrayBuffer | undefined {
      const entry = encoded.get(source)
      if (!entry) return undefined
      if (!entry.value.byteLength) {
        encoded.delete(source)
        return undefined
      }
      encoded.delete(source)
      encoded.set(source, entry)
      return entry.value.slice(0)
    },
    putEncoded(source, data): void {
      if (!source || !data.byteLength || data.byteLength > maximumEncoded || maximumEntries === 0)
        return
      // The caller can immediately pass its original to native decoding.
      insert(encoded, source, data.slice(0), data.byteLength, maximumEncoded)
    },
    delete(source): void {
      pcm.delete(source)
      encoded.delete(source)
    },
    clear(): void {
      pcm.clear()
      encoded.clear()
    },
    get pcmBytes(): number {
      return bytesIn(pcm)
    },
    get encodedBytes(): number {
      return bytesIn(encoded)
    },
    get pcmEntries(): number {
      return pcm.size
    },
    get encodedEntries(): number {
      return encoded.size
    },
  }
}
