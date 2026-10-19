import { describe, expect, it } from 'vitest'
import { ResponseTooLargeError } from '../core/read-json-with-limit'
import { decodeQrc, unwrapQrc } from '../core/lyrics/qrc'

// Synthetic text encrypted by the independent Robotxm reference implementation.
const ENCRYPTED = 'bb1db48dc814ca529e7b84a6f388ca053e39faa6800d93d41d20a6c5945f8eb97f0e0740bc3663e8'
const ENCRYPTED_XML =
  '0c8d67dd3e549974b64ed2680459f138553fe2b7cdeb268e33263ce3ef74605977e46a86d6e15cc23e1a2e77ddeea64804bfcafb8f7d39b5c2d4a2ed8799711285d4861ede9e88191d8e01111e90c9406dd39e2a60c6b3bc39875fae3fb3fb27fef79305a584c913aa11d17ebcf9e173'

describe('QRC decoding', () => {
  it('decrypts the custom DES variant and removes its compressed zero padding', async () => {
    await expect(decodeQrc(ENCRYPTED, new AbortController().signal)).resolves.toBe(
      '[0,1000]one(0,500) two(500,500)',
    )
  })

  it('decrypts XML, preserves word timing and decodes entities', async () => {
    await expect(decodeQrc(ENCRYPTED_XML, new AbortController().signal)).resolves.toBe(
      '[0,1000]你&我(0,1000)',
    )
  })

  it('keeps a zero byte belonging to the checksum rather than the cipher padding', async () => {
    await expect(
      decodeQrc('bb1db48dc814ca52b45a5837e9ef9990c4e94eca7ce627ac', new AbortController().signal),
    ).resolves.toBe('[0,1000]>~(0,1000)')
  })

  it('accepts existing clear text and strips the XML wrapper without a DOM', async () => {
    const plain = '[0,1000]test(0,1000)'
    await expect(decodeQrc(plain, new AbortController().signal)).resolves.toBe(plain)
    expect(
      unwrapQrc(
        '<QrcInfos><Lyric_1 LyricType="1" LyricContent="&#x4f60;&#22909;&amp;quot;(0,2)"/></QrcInfos>',
      ),
    ).toBe('你好&quot;(0,2)')
    expect(() => unwrapQrc('<QrcInfos><LyricInfo/></QrcInfos>')).toThrow('Invalid QRC XML')
  })

  it.each(['', 'not hex', '1234', '0'.repeat(16)])(
    'rejects corrupt ciphertext %s',
    async (input) => {
      await expect(decodeQrc(input, new AbortController().signal)).rejects.toThrow()
    },
  )

  it('enforces the ciphertext limit before allocating or decrypting blocks', async () => {
    await expect(
      decodeQrc('0'.repeat(128 * 1024 + 16), new AbortController().signal),
    ).rejects.toBeInstanceOf(ResponseTooLargeError)
  })

  it('limits decompressed output, including very small compression bombs', async () => {
    const bomb =
      '31dc07d68f408bb2a891995cb541e2e950f91e3c0bd73607a' +
      '27b02aa779bf226a'.repeat(61) +
      '27b02aa779bf226e67d3929095ed6614257f81e2e4ee77b'
    await expect(decodeQrc(bomb, new AbortController().signal)).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    )
  })

  it('stops an already cancelled decode', async () => {
    const controller = new AbortController()
    controller.abort(new Error('song changed'))
    await expect(decodeQrc(ENCRYPTED, controller.signal)).rejects.toThrow('song changed')
  })
})
