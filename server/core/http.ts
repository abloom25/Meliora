export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  const headers = new Headers(extraHeaders)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  // API 响应统一注入基础安全头:Cloudflare Pages 与 Netlify 的平台级 headers
  // 不作用于 Function 响应,必须在代码层保证三平台一致
  if (!headers.has('X-Content-Type-Options')) headers.set('X-Content-Type-Options', 'nosniff')
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(body), { status, headers })
}
