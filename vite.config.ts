import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { validateMusicConfig } from './shared/config-schema'
import { generatePublicConfig } from './scripts/generate-public-config.mjs'
import { publicMusicConfig } from './src/generated/public-config'
import { DEV_MUSIC_PROXY_PREFIX } from './shared/dev-music-proxy'
import { guardDevMusicProxy, isLocalConfigWriteAllowed } from './scripts/dev-request-guards'
import { DEV_SHARE_COVER_PATH } from './shared/share-cover'
import { getShareCover } from './server/core/cover-handler'

const localDevConfigPath = join(process.cwd(), '.meliora/config.local.json')
const beatRuntimeModule = createRequire(import.meta.url)
  .resolve('onnxruntime-web/all')
  .replace(/\.js$/, '.mjs')
function externalBeatRuntime(): Plugin {
  return {
    name: 'beat-runtime-external-wasm',
    enforce: 'pre',
    resolveId(source) {
      if (source === 'onnxruntime-web/all') return beatRuntimeModule
    },
  }
}
const musicApiEndpoint = /^https?:\/\//i.test(publicMusicConfig.apiEndpoint)
  ? new URL(publicMusicConfig.apiEndpoint)
  : null

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(body))
}

function melioraLocalConfigPlugin(): Plugin {
  return {
    name: 'meliora-local-config',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(guardDevMusicProxy(musicApiEndpoint))
      server.middlewares.use(DEV_SHARE_COVER_PATH, async (request, response) => {
        const controller = new AbortController()
        const cancel = (): void => {
          if (!response.writableEnded) controller.abort()
        }
        response.once('close', cancel)
        try {
          const result = await getShareCover(
            new Request(new URL(request.url ?? '/', 'http://localhost'), {
              method: request.method,
              signal: controller.signal,
            }),
            request.socket.remoteAddress,
          )
          if (controller.signal.aborted) return
          response.statusCode = result.status
          result.headers.forEach((value, key) => response.setHeader(key, value))
          response.end(Buffer.from(await result.arrayBuffer()))
        } catch {
          if (!controller.signal.aborted) sendJson(response, 502, { error: '封面暂时无法载入' })
        } finally {
          response.removeListener('close', cancel)
        }
      })
      server.middlewares.use('/__meliora-dev/config', async (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'Method Not Allowed' })
          return
        }

        if (!isLocalConfigWriteAllowed(request)) {
          sendJson(response, 403, { error: '仅允许同源 JSON 配置请求' })
          return
        }

        try {
          const parsed = JSON.parse(await readBody(request))
          const validation = validateMusicConfig(parsed, { allowPrivateUrls: true })
          if (!validation.valid || !validation.config) {
            sendJson(response, 400, {
              error: '配置校验失败',
              details: validation.errors,
            })
            return
          }

          await mkdir(dirname(localDevConfigPath), { recursive: true })
          await writeFile(localDevConfigPath, `${JSON.stringify(validation.config, null, 2)}\n`)
          await generatePublicConfig({
            configPath: localDevConfigPath,
            adminEnv: { DEVELOPMENT: 'true' },
          })
          server.ws.send({ type: 'full-reload' })
          sendJson(response, 200, { ok: true })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendJson(response, 500, { error: message || '本地配置同步失败' })
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  worker: { format: 'es', plugins: () => [externalBeatRuntime()] },
  plugins: [vue(), melioraLocalConfigPlugin(), externalBeatRuntime()],
  server: {
    host: '0.0.0.0',
    port: 5175,
    proxy: {
      ...(musicApiEndpoint
        ? {
            [`${DEV_MUSIC_PROXY_PREFIX}/`]: {
              target: musicApiEndpoint.origin,
              changeOrigin: true,
              // 让手机沿用已获准的本机开发来源,远程音乐接口不认识局域网 IP。
              headers: {
                Origin: 'http://localhost:5175',
                Referer: 'http://localhost:5175/',
                Cookie: '',
                Authorization: '',
              },
              rewrite: (path: string) => path.slice(DEV_MUSIC_PROXY_PREFIX.length),
            },
          }
        : {}),
      '/api': {
        target: 'http://localhost:8788',
        // 保留浏览器访问的 Host,使局域网请求通过后端同源校验。
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/tests/setup.ts'],
    include: ['src/tests/**/*.test.ts', 'server/tests/**/*.test.ts'],
  },
})
