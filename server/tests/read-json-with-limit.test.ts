import { describe, expect, it } from 'vitest'
import { ResponseTooLargeError, readJsonWithLimit } from '../core/read-json-with-limit'

describe('readJsonWithLimit', () => {
  it('parses JSON bodies within the byte limit', async () => {
    const response = new Response(JSON.stringify({ ok: true }))

    await expect(readJsonWithLimit(response, 1024)).resolves.toEqual({ ok: true })
  })

  it('rejects before reading when Content-Length exceeds the limit', async () => {
    const response = new Response('{}', {
      headers: { 'Content-Type': 'application/json', 'Content-Length': '2048' },
    })

    await expect(readJsonWithLimit(response, 1024)).rejects.toBeInstanceOf(ResponseTooLargeError)
  })

  it('rejects while streaming when the body grows past the limit', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"data":"${'x'.repeat(4096)}`))
        controller.close()
      },
    })
    const response = new Response(stream)

    await expect(readJsonWithLimit(response, 1024)).rejects.toBeInstanceOf(ResponseTooLargeError)
  })
})
