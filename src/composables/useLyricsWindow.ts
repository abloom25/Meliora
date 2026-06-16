import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { LyricsSnapshot, Track } from '../types/music'

interface DocumentPictureInPictureApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>
}

interface LyricsWindowOptions {
  currentTrack: Ref<Track | null>
  currentTime: Ref<number>
  isPlaying: Ref<boolean>
}

const popupStyles = `
  :root { color-scheme: dark; font-family: -apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; overflow: hidden; background: #17171a; color: #fff; }
  .background { position: fixed; inset: -15%; background-position: center; background-size: cover; filter: blur(55px) saturate(1.2); opacity: .55; transform: scale(1.15); }
  .shade { position: fixed; inset: 0; background: linear-gradient(180deg,rgba(10,10,12,.32),rgba(10,10,12,.82)); }
  main { position: relative; display: flex; height: 100vh; flex-direction: column; padding: 24px 26px 30px; }
  header { display: grid; grid-template-columns: 48px minmax(0,1fr); align-items: center; gap: 12px; }
  .cover { width: 48px; height: 48px; border-radius: 14px; object-fit: cover; background: rgba(255,255,255,.1); box-shadow: 0 10px 30px rgba(0,0,0,.3); }
  .copy { min-width: 0; }
  h1,p { overflow: hidden; margin: 0; text-overflow: ellipsis; white-space: nowrap; }
  h1 { font-size: 15px; letter-spacing: -.02em; }
  p { margin-top: 4px; color: rgba(255,255,255,.56); font-size: 12px; }
  .lyrics { display: flex; min-height: 0; flex: 1; flex-direction: column; justify-content: center; gap: 13px; padding-top: 18px; }
  .line { color: rgba(255,255,255,.27); font-size: clamp(21px,5.4vw,31px); font-weight: 690; line-height: 1.16; letter-spacing: -.035em; transition: opacity .45s ease,color .45s ease,text-shadow .45s ease; }
  .line.active { color: #fff; text-shadow: 0 0 20px rgba(255,255,255,.18); }
  .translation { display: block; margin-top: .2em; font-size: .68em; opacity: .72; }
  .state { margin: auto 0; color: rgba(255,255,255,.5); font-size: 18px; font-weight: 620; }
`

export function useLyricsWindow({
  currentTrack,
  currentTime,
  isPlaying,
}: LyricsWindowOptions) {
  const snapshot = ref<LyricsSnapshot>({
    lines: [],
    activeIndex: -1,
    status: 'idle',
  })
  const isOpen = ref(false)
  let lyricsWindow: Window | null = null

  function setSnapshot(value: LyricsSnapshot) {
    snapshot.value = value
    render()
  }

  function createDocument(target: Window) {
    target.document.open()
    target.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meliora 歌词</title><style>${popupStyles}</style></head><body><div class="background"></div><div class="shade"></div><main><header><img class="cover" alt=""><div class="copy"><h1></h1><p></p></div></header><section class="lyrics"></section></main></body></html>`)
    target.document.close()
    target.addEventListener('pagehide', () => {
      if (lyricsWindow === target) {
        lyricsWindow = null
        isOpen.value = false
      }
    })
  }

  function render() {
    const target = lyricsWindow
    if (!target || target.closed) {
      if (lyricsWindow) isOpen.value = false
      return
    }

    const document = target.document
    const track = currentTrack.value
    const cover = document.querySelector<HTMLImageElement>('.cover')
    const title = document.querySelector<HTMLElement>('h1')
    const artist = document.querySelector<HTMLElement>('header p')
    const background = document.querySelector<HTMLElement>('.background')
    const lyrics = document.querySelector<HTMLElement>('.lyrics')
    if (!cover || !title || !artist || !background || !lyrics) return

    title.textContent = track?.title || 'Meliora'
    artist.textContent = track?.artist || (isPlaying.value ? '正在播放' : '已暂停')
    cover.src = track?.cover || new URL('favicon.svg', window.location.href).href
    background.style.backgroundImage = track?.cover ? `url("${track.cover.replaceAll('"', '\\"')}")` : 'none'
    lyrics.replaceChildren()

    if (snapshot.value.status !== 'ready' || !snapshot.value.lines.length) {
      return
    }

    const active = Math.max(0, snapshot.value.activeIndex)
    const start = Math.max(0, active - 1)
    const end = Math.min(snapshot.value.lines.length, active + 3)
    snapshot.value.lines.slice(start, end).forEach((line, offset) => {
      const index = start + offset
      const element = document.createElement('div')
      element.className = `line ${index === active ? 'active' : index < active ? 'before' : 'after'}`
      element.dataset.index = String(index)
      element.textContent = line.text
      if (line.translation) {
        const translation = document.createElement('span')
        translation.className = 'translation'
        translation.textContent = line.translation
        element.append(translation)
      }
      lyrics.append(element)
    })

  }

  async function toggleLyricsWindow() {
    if (lyricsWindow && !lyricsWindow.closed) {
      lyricsWindow.close()
      lyricsWindow = null
      isOpen.value = false
      return
    }

    const pictureInPicture = (
      window as typeof window & { documentPictureInPicture?: DocumentPictureInPictureApi }
    ).documentPictureInPicture

    lyricsWindow = pictureInPicture
      ? await pictureInPicture.requestWindow({ width: 430, height: 600 })
      : window.open('', 'meliora-lyrics', 'popup,width=430,height=600,resizable=yes')

    if (!lyricsWindow) throw new Error('Lyrics window was blocked')
    createDocument(lyricsWindow)
    isOpen.value = true
    render()
  }

  watch([currentTrack, currentTime, isPlaying], render)
  onBeforeUnmount(() => lyricsWindow?.close())

  return { isOpen, setSnapshot, toggleLyricsWindow }
}
