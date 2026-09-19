import type { PublicMusicConfig } from '../types/music'
import { publicMusicConfig } from '../generated/public-config'
import { resolveDevMusicUrl } from '../../shared/dev-music-proxy'

export const musicConfig: PublicMusicConfig = publicMusicConfig

export function resolveMusicRequestUrl(url: string): string {
  return resolveDevMusicUrl(url, musicConfig.apiEndpoint, import.meta.env.DEV)
}
