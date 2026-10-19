/** Public response contract for native platform lyrics. No account credentials cross this boundary. */
export type NativeLyricsSource = 'netease' | 'qq'

export interface NativeLyricsData {
  source: NativeLyricsSource
  format: 'yrc' | 'qrc'
  lyrics: string
  translation?: string
  romanization?: string
}

export type NativeLyricsResult =
  | { status: 'found'; data: NativeLyricsData }
  | { status: 'missing' }
  | { status: 'unavailable' }
