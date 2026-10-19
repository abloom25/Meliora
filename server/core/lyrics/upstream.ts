import { ResponseTooLargeError } from '../read-json-with-limit'

export const MAX_LYRICS_RESPONSE_BYTES = 1024 * 1024

/** Bound the entire operation, including a fetch/body implementation that ignores abort. */
export function withLyricsAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? new Error('Lyrics request aborted'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}

/** Also usable on decompressed bodies: the limit applies to the actual streamed bytes. */
export async function readLyricsBytes(
  response: Response,
  signal: AbortSignal,
  maxBytes: number = MAX_LYRICS_RESPONSE_BYTES,
): Promise<Uint8Array> {
  signal.throwIfAborted()
  const declaredLength = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    void response.body?.cancel().catch(() => undefined)
    throw new ResponseTooLargeError('Lyrics response too large')
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined)
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    while (true) {
      const chunk = await withLyricsAbort(reader.read(), signal)
      signal.throwIfAborted()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > maxBytes) {
        cancel()
        throw new ResponseTooLargeError('Lyrics response too large')
      }
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

/** Only callers with fixed platform URLs use this helper; it is not an arbitrary URL proxy. */
export async function fetchLyricsJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted()
  // workerd only supports follow/manual; reject returned redirects via the status check below.
  const response = await withLyricsAbort(
    fetch(url, { ...init, redirect: 'manual', signal }),
    signal,
  )
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error(`Lyrics upstream returned ${response.status}`)
  }
  return JSON.parse(new TextDecoder().decode(await readLyricsBytes(response, signal)))
}
