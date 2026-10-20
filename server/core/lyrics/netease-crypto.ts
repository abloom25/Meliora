// The EAPI envelope follows NetEase's public client protocol, documented by
// https://github.com/Robotxm/ESLyric-LyricsSource/blob/master/current/yrc/searcher/netease_ex.js.
// MD5 below implements RFC 1321; it is only a protocol checksum, never a security primitive.
const EAPI_KEY = 'e82ckenh8dichen8'
const ROTATIONS = [
  [7, 12, 17, 22],
  [5, 9, 14, 20],
  [4, 11, 16, 23],
  [6, 10, 15, 21],
]
const CONSTANTS = Uint32Array.from({ length: 64 }, (_, index) =>
  Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000),
)
let keyPromise: Promise<CryptoKey> | undefined

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function md5Hex(text: string): string {
  const source = new TextEncoder().encode(text)
  const padded = new Uint8Array(Math.ceil((source.length + 9) / 64) * 64)
  padded.set(source)
  padded[source.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, (source.length * 8) >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(source.length / 0x20000000), true)
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]

  for (let offset = 0; offset < padded.length; offset += 64) {
    let [a, b, c, d] = state
    for (let index = 0; index < 64; index += 1) {
      const round = Math.floor(index / 16)
      let mixed: number
      let word: number
      if (round === 0) {
        mixed = (b & c) | (~b & d)
        word = index
      } else if (round === 1) {
        mixed = (b & d) | (c & ~d)
        word = (5 * index + 1) % 16
      } else if (round === 2) {
        mixed = b ^ c ^ d
        word = (3 * index + 5) % 16
      } else {
        mixed = c ^ (b | ~d)
        word = (7 * index) % 16
      }
      const sum = (a + mixed + CONSTANTS[index] + view.getUint32(offset + word * 4, true)) | 0
      const rotation = ROTATIONS[round][index % 4]
      const rotated = (sum << rotation) | (sum >>> (32 - rotation))
      ;[a, b, c, d] = [d, (b + rotated) | 0, b, c]
    }
    state[0] = (state[0] + a) | 0
    state[1] = (state[1] + b) | 0
    state[2] = (state[2] + c) | 0
    state[3] = (state[3] + d) | 0
  }

  const result = new Uint8Array(16)
  const resultView = new DataView(result.buffer)
  state.forEach((word, index) => resultView.setUint32(index * 4, word, true))
  return bytesToHex(result)
}

function getEapiKey(): Promise<CryptoKey> {
  keyPromise ??= crypto.subtle
    .importKey('raw', new TextEncoder().encode(EAPI_KEY), 'AES-CBC', false, ['encrypt'])
    .catch((error: unknown) => {
      keyPromise = undefined
      throw error
    })
  return keyPromise
}

export async function encryptNeteaseParams(path: string, data: object): Promise<string> {
  const text = JSON.stringify(data)
  const digest = md5Hex(`nobody${path}use${text}md5forencrypt`)
  const source = new TextEncoder().encode(`${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`)
  const padding = 16 - (source.length % 16)
  const padded = new Uint8Array(source.length + padding)
  padded.set(source)
  padded.fill(padding, source.length)
  const key = await getEapiKey()
  const blocks: Array<Promise<Uint8Array>> = []

  // WebCrypto has no ECB. Encrypt each block with a fresh zero CBC IV, then
  // discard WebCrypto's extra padding block: CBC's first block is exactly ECB.
  for (let offset = 0; offset < padded.length; offset += 16) {
    blocks.push(
      crypto.subtle
        .encrypt(
          { name: 'AES-CBC', iv: new Uint8Array(16) },
          key,
          padded.slice(offset, offset + 16),
        )
        .then((encrypted) => new Uint8Array(encrypted).slice(0, 16)),
    )
  }
  const encrypted = new Uint8Array(padded.length)
  ;(await Promise.all(blocks)).forEach((block, index) => encrypted.set(block, index * 16))
  return bytesToHex(encrypted).toUpperCase()
}
