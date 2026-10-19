export class ResponseTooLargeError extends Error {}

// 带字节上限的 JSON 读取:先查 Content-Length 快速拒绝,再按流式分块累计,
// 超过 maxBytes 立即 cancel 并抛错,避免不可信上游把超大响应全量读入内存。
// 同时适用于上游 Response 与入站 Request(未认证端点的请求体 DoS 防护)。
export async function readBytesWithLimit(
  response: Response | Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    void response.body?.cancel('response body exceeds limit').catch(() => {})
    throw new ResponseTooLargeError('response body exceeds limit')
  }

  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new ResponseTooLargeError('response body exceeds limit')
    }
    return new TextEncoder().encode(text)
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let receivedBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      receivedBytes += value.byteLength
      if (receivedBytes > maxBytes) {
        void reader.cancel('response body exceeds limit').catch(() => {})
        throw new ResponseTooLargeError('response body exceeds limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(receivedBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function readJsonWithLimit(
  response: Response | Request,
  maxBytes: number,
): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await readBytesWithLimit(response, maxBytes)))
}
