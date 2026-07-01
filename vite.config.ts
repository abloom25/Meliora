import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { validateMusicConfig } from './shared/config-schema'
import { generatePublicConfig } from './scripts/generate-public-config.mjs'

const localDevConfigPath = join(process.cwd(), '.meliora/config.local.json')

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
      server.middlewares.use('/__meliora-dev/config', async (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'Method Not Allowed' })
          return
        }

        try {
          const parsed = JSON.parse(await readBody(request))
          const validation = validateMusicConfig(parsed)
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
  plugins: [vue(), melioraLocalConfigPlugin()],
  server: {
    port: 5175,
    proxy: {
      '/api': {
        target: 'http://localhost:8788',
        changeOrigin: true,
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
