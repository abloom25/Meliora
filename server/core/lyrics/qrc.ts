import { ResponseTooLargeError } from '../read-json-with-limit'
import { decryptQrcBlocks } from './qrc-cipher'
import { readLyricsBytes } from './upstream'

const MAX_ENCRYPTED_BYTES = 64 * 1024
const MAX_DECODED_BYTES = 512 * 1024

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
    if (!name.startsWith('#')) return named[name.toLowerCase()] ?? entity
    const value =
      name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value)
      : entity
  })
}

/** QQ sometimes wraps the timing text in an XML attribute, including literal newlines. */
export function unwrapQrc(text: string): string {
  const normalized = text.replace(/^\uFEFF/, '').trim()
  if (!normalized.startsWith('<')) return normalized
  const match = /<Lyric_1\b[\s\S]*?\bLyricContent\s*=\s*(["'])([\s\S]*?)\1\s*\/>/i.exec(normalized)
  if (!match) throw new Error('Invalid QRC XML')
  return decodeEntities(match[2] ?? '').trim()
}

/** Decode QQ's custom triple-DES blocks, then a bounded zlib stream. */
export async function decodeQrc(content: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  if (content.length > MAX_ENCRYPTED_BYTES * 2) throw new ResponseTooLargeError('QRC too large')
  const normalized = content.trim()
  if (normalized.startsWith('[') || normalized.startsWith('<')) return unwrapQrc(normalized)
  if (!normalized || normalized.length % 16 !== 0 || !/^[\da-f]+$/i.test(normalized)) {
    throw new Error('Invalid encrypted QRC')
  }
  const encrypted = new Uint8Array(normalized.length / 2)
  for (let offset = 0; offset < normalized.length; offset += 2) {
    encrypted[offset / 2] = parseInt(normalized.slice(offset, offset + 2), 16)
  }
  const decrypted = decryptQrcBlocks(encrypted, signal)
  // QQ pads its compressed stream with zeroes to the next eight-byte block. The web
  // decompressor rejects this trailing padding. A checksum can itself end in zero,
  // so try restoring those bytes if removing all possible padding is insufficient.
  let padding = 0
  while (padding < 7 && decrypted[decrypted.length - 1 - padding] === 0) padding++
  for (let removed = padding; removed >= 0; removed--) {
    signal.throwIfAborted()
    const bytes = decrypted.slice(0, decrypted.length - removed)
    const stream = new Response(bytes.buffer).body!.pipeThrough(new DecompressionStream('deflate'))
    try {
      const output = await readLyricsBytes(new Response(stream), signal, MAX_DECODED_BYTES)
      return unwrapQrc(new TextDecoder('utf-8', { fatal: true }).decode(output))
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof ResponseTooLargeError || removed === 0) throw error
    }
  }
  throw new Error('Invalid QRC stream')
}
