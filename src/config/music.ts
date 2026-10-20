// 曲库配置的取用口。
//
// Web 端的配置是构建期生成的(scripts/generate-public-config.mjs 写出
// src/generated/public-config.ts),所以默认值直接来自那份生成物。
// 桌面端没有构建期注入这一说 —— 配置来自用户可编辑的本地文件,启动时读出来
// 调一次 setMusicConfig 即可,下游只认 musicConfig(),不知道它从哪来。

import type { PublicMusicConfig } from '../../shared/music-config'
import { publicMusicConfig } from '../generated/public-config'
import { resolveDevMusicUrl } from '../../shared/dev-music-proxy'

let current: PublicMusicConfig = publicMusicConfig

export function musicConfig(): PublicMusicConfig {
  return current
}

/** 替换曲库配置。传 null 恢复为构建期生成的那份 */
export function setMusicConfig(config: PublicMusicConfig | null): void {
  current = config ?? publicMusicConfig
}

export function resolveMusicRequestUrl(url: string): string {
  // Vite 代理目标来自构建配置,运行时替换配置不能把新接口转发到旧目标。
  return resolveDevMusicUrl(url, publicMusicConfig.apiEndpoint, import.meta.env.DEV)
}
