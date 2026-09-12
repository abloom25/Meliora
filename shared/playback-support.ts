import type { MusicConfig } from './music-config'

export const TOKEN_PLAYBACK_UNSUPPORTED =
  '播放器暂不支持需要 Token 的音源，请清空 API Token 并改用无需鉴权的公开接口'

/** 兼容读取旧配置，但管理端不能把受保护音源误判为播放器可用。 */
export function getPlaybackSupportError(config: MusicConfig): string | null {
  return config.apiToken?.trim() && config.playlists.some((playlist) => playlist.enabled !== false)
    ? TOKEN_PLAYBACK_UNSUPPORTED
    : null
}
