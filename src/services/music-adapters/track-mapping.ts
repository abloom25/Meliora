// 外部曲库数据到领域 Track 的映射。
//
// 放在适配器层而不是核心层:Meting 的返回结构、后台本地曲目配置都是**外部服务/部署**
// 的形状,核心层只该认识 Track 本身。换一个曲库来源,只需在这里加一个映射。

import type { Track } from '../../core/types'
import type { LocalTrackConfig } from '../../../shared/music-config'
import { createTrackShareId } from '../../core/library/tracks'
import { splitDisplayTitle } from '../../core/library/title'
import type { MetingTrack } from './types'

export function mapMetingTrack(track: MetingTrack, sourceKey: string, index: number): Track | null {
  if (!track.title?.trim() || !track.url?.trim()) return null
  const rawTitle = track.title.trim()
  const displayTitle = splitDisplayTitle(track.title)
  const mapped: Track = {
    id: `meting:${sourceKey}:${index}:${track.url}`,
    title: displayTitle.title,
    titleVersions: displayTitle.versions.length ? displayTitle.versions : undefined,
    artist: track.author?.trim() || '未知艺术家',
    cover: track.pic?.trim() || undefined,
    audioUrl: track.url.trim(),
    kind: 'meting',
  }
  const legacyShareId = createTrackShareId({
    title: rawTitle,
    artist: mapped.artist,
  })
  if (legacyShareId !== createTrackShareId(mapped)) mapped.shareAliases = [legacyShareId]
  return mapped
}

export function mapLocalTrack(track: LocalTrackConfig): Track {
  const rawTitle = track.title.trim()
  const displayTitle = splitDisplayTitle(track.title)
  const mapped: Track = {
    id: `local:${track.id}`,
    title: displayTitle.title,
    titleVersions: displayTitle.versions.length ? displayTitle.versions : undefined,
    artist: track.artist,
    album: track.album,
    cover: track.cover,
    audioUrl: track.audio,
    kind: 'local',
  }
  const legacyShareId = createTrackShareId({
    title: rawTitle,
    artist: mapped.artist,
  })
  if (legacyShareId !== createTrackShareId(mapped)) mapped.shareAliases = [legacyShareId]
  return mapped
}
