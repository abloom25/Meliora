import type { MusicConfig } from '../types/music'

export const musicConfig: MusicConfig = {
  siteName: 'Meliora',
  apiEndpoint: 'https://api.music.abloom.site/api',
  playlists: [
    {
      server: 'netease',
      playlistId: '17390341309',
      enabled: true,
    },
    {
      server: 'tencent',
      playlistId: '9729586480',
      enabled: true,
    },
  ],
  localTracks: [
    {
      id: 'devotion-no-party-for-cao-dong',
      title: 'DEVOTION 还愿',
      artist: '草东没有派对',
      album: 'DEVOTION',
      audio: './music/DEVOTION/audio.flac',
      cover: './music/DEVOTION/cover.jpg',
      lyrics: './music/DEVOTION/lyrics.lrc',
    },
  ],
}
