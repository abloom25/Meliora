import type { MusicConfig } from './music-config'

export const TOKEN_PLAYBACK_UNSUPPORTED =
  '播放器暂不支持需要 Token 的音源，请清空 API Token 并改用无需鉴权的公开接口'

/** 兼容读取旧配置，但管理端不能把受保护音源误判为播放器可用。 */
export function getPlaybackSupportError(config: MusicConfig): string | null {
  // playlists 可能缺失:旧配置、以及 fetchConfig 直接把 /api/config 的原始 JSON
  // 断言成 MusicConfig 而不经校验。兼容读取是这个函数的本分,不能在这里抛
  const playlists = Array.isArray(config.playlists) ? config.playlists : []
  return config.apiToken?.trim() && playlists.some((playlist) => playlist.enabled !== false)
    ? TOKEN_PLAYBACK_UNSUPPORTED
    : null
}
