import { onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { usePlayerStore } from '../stores/player'
import { loadLyricsText } from '../services/lyrics'
import type { Track } from '../types/music'

const CROSSFADE_DURATION = 650

function createAudio(preload: HTMLMediaElement['preload']) {
  const audio = new Audio()
  audio.preload = preload
  audio.crossOrigin = 'anonymous'
  return audio
}

export function useAudioPlayer() {
  const store = usePlayerStore()
  const { currentTrack, isPlaying, currentTime, duration, settings } = storeToRefs(store)
  const players = [createAudio('metadata'), createAudio('auto')] as const
  let activeAudio = players[0]
  let standbyAudio = players[1]
  const beatLevel = ref(0)
  const preloadMessage = ref('')
  const failedTrackIds = new Set<string>()
  let preloadedTrack: Track | null = null
  let preloadReady: Promise<boolean> | null = null
  let transitionInProgress = false
  let automaticCrossfadeStarted = false
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let frequencyData: Uint8Array<ArrayBuffer> | null = null
  let beatFrame = 0
  let energyFloor = 0.08
  let volumeAnimation = 0

  function predictNextTrack(manual = false): Track | null {
    const queue = store.queue
    if (!queue.length) return null
    if (settings.value.playMode === 'single' && !manual) return currentTrack.value

    if (settings.value.playMode === 'shuffle' && queue.length > 1) {
      if (
        preloadedTrack
        && preloadedTrack.id !== currentTrack.value?.id
        && !failedTrackIds.has(preloadedTrack.id)
      ) return preloadedTrack

      const candidates = queue.filter(
        (track) => track.id !== currentTrack.value?.id && !failedTrackIds.has(track.id),
      )
      return candidates[Math.floor(Math.random() * candidates.length)] ?? null
    }

    for (let offset = 1; offset <= queue.length; offset += 1) {
      const index = store.currentIndex + offset
      if (settings.value.playMode === 'sequence' && index >= queue.length) return null
      const track = queue[index % queue.length]
      if (track && !failedTrackIds.has(track.id)) return track
    }
    return null
  }

  function preloadCover(url?: string) {
    if (!url) return Promise.resolve()
    const image = new Image()
    image.src = url
    return image.decode?.().catch(() => undefined) ?? Promise.resolve()
  }

  async function preloadLyrics(url?: string) {
    if (!url) return
    try {
      await loadLyricsText(url)
    } catch {
      // Lyrics failure must not block audio playback.
    }
  }

  function clearStandby() {
    preloadedTrack = null
    preloadReady = null
    standbyAudio.pause()
    standbyAudio.removeAttribute('src')
    standbyAudio.load()
  }

  function loadStandby(track: Track): Promise<boolean> {
    if (preloadedTrack?.id === track.id && preloadReady) return preloadReady

    clearStandby()
    preloadedTrack = track
    standbyAudio.volume = 0
    preloadReady = new Promise<boolean>((resolve) => {
      const cleanup = () => {
        standbyAudio.removeEventListener('canplay', handleReady)
        standbyAudio.removeEventListener('loadeddata', handleReady)
        standbyAudio.removeEventListener('error', handleError)
      }
      const handleReady = () => {
        cleanup()
        resolve(true)
      }
      const handleError = () => {
        cleanup()
        failedTrackIds.add(track.id)
        preloadMessage.value = `《${track.title}》无法加载，正在尝试下一首`
        preloadedTrack = null
        preloadReady = null
        resolve(false)
        window.setTimeout(preloadNextTrack, 0)
      }
      standbyAudio.addEventListener('canplay', handleReady, { once: true })
      standbyAudio.addEventListener('loadeddata', handleReady, { once: true })
      standbyAudio.addEventListener('error', handleError, { once: true })
    })
    standbyAudio.src = track.audioUrl
    standbyAudio.load()
    void preloadCover(track.cover)
    void preloadLyrics(track.lyricsUrl)
    return preloadReady
  }

  function preloadNextTrack() {
    if (!settings.value.preloadNextTrack || transitionInProgress) return
    const track = predictNextTrack()
    if (!track || track.id === currentTrack.value?.id) return
    void loadStandby(track)
  }

  function setPlayerVolume(audio: HTMLAudioElement, gain: number) {
    audio.volume = Math.max(0, Math.min(1, settings.value.volume * gain))
  }

  function crossfadePlayers(oldAudio: HTMLAudioElement, newAudio: HTMLAudioElement) {
    const animationId = ++volumeAnimation
    const startedAt = performance.now()
    return new Promise<void>((resolve) => {
      function step(now: number) {
        if (animationId !== volumeAnimation) {
          resolve()
          return
        }
        const progress = Math.min(1, (now - startedAt) / CROSSFADE_DURATION)
        const eased = progress * progress * (3 - 2 * progress)
        setPlayerVolume(oldAudio, 1 - eased)
        setPlayerVolume(newAudio, eased)
        if (progress < 1) window.requestAnimationFrame(step)
        else resolve()
      }
      window.requestAnimationFrame(step)
    })
  }

  function stopBeatAnalysis() {
    window.cancelAnimationFrame(beatFrame)
    beatFrame = 0
    beatLevel.value = 0
  }

  function updateBeatLevel() {
    if (!analyser || !frequencyData || activeAudio.paused) {
      beatLevel.value *= 0.88
      if (beatLevel.value > 0.005) beatFrame = window.requestAnimationFrame(updateBeatLevel)
      else stopBeatAnalysis()
      return
    }
    analyser.getByteFrequencyData(frequencyData)
    const bassBins = Math.max(4, Math.min(18, Math.floor(frequencyData.length * 0.07)))
    let energy = 0
    for (let index = 1; index < bassBins; index += 1) {
      const value = frequencyData[index] ?? 0
      energy += value * value
    }
    energy = Math.sqrt(energy / Math.max(1, bassBins - 1)) / 255
    energyFloor = energyFloor * 0.975 + energy * 0.025
    const pulse = Math.max(0, Math.min(1, (energy - energyFloor * 0.82) * 3.6))
    beatLevel.value += (pulse - beatLevel.value) * (pulse > beatLevel.value ? 0.42 : 0.09)
    beatFrame = window.requestAnimationFrame(updateBeatLevel)
  }

  async function startBeatAnalysis() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    try {
      if (!audioContext) {
        audioContext = new AudioContext()
        analyser = audioContext.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.58
        players.forEach((audio) => {
          const source = audioContext!.createMediaElementSource(audio)
          source.connect(analyser!)
        })
        analyser.connect(audioContext.destination)
        frequencyData = new Uint8Array(analyser.frequencyBinCount)
      }
      if (audioContext.state === 'suspended') await audioContext.resume()
      if (!beatFrame) beatFrame = window.requestAnimationFrame(updateBeatLevel)
    } catch {
      stopBeatAnalysis()
    }
  }

  function syncMediaSession() {
    if (!('mediaSession' in navigator) || !currentTrack.value) return
    const track = currentTrack.value
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album || 'Meliora',
      artwork: track.cover ? [{ src: track.cover }] : [],
    })
    navigator.mediaSession.playbackState = isPlaying.value ? 'playing' : 'paused'
  }

  async function play() {
    if (!currentTrack.value) {
      const first = store.queue[0] ?? store.tracks[0]
      if (!first) return
      store.selectTrack(first, store.queue.length ? store.queue : store.tracks)
      await Promise.resolve()
    }
    try {
      setPlayerVolume(activeAudio, 1)
      await activeAudio.play()
      isPlaying.value = true
      store.errorMessage = ''
      void startBeatAnalysis()
    } catch (error) {
      isPlaying.value = false
      const reason = error as DOMException
      if (reason.name === 'NotAllowedError') store.errorMessage = '浏览器阻止了播放，请再次点击播放'
      else if (reason.name === 'NotSupportedError') store.errorMessage = '浏览器无法解码当前音频'
      else if (reason.name !== 'AbortError') store.errorMessage = '当前歌曲无法播放，请稍后再试'
    }
  }

  function pause() {
    volumeAnimation += 1
    activeAudio.pause()
    standbyAudio.pause()
    isPlaying.value = false
  }

  function toggle() {
    if (isPlaying.value) pause()
    else void play()
  }

  function seek(time: number) {
    if (!Number.isFinite(time)) return
    activeAudio.currentTime = Math.max(0, Math.min(time, duration.value || time))
    currentTime.value = activeAudio.currentTime
  }

  async function switchToTrack(
    track: Track,
    queue: Track[],
    updateStore: () => void,
    shouldPlay: boolean,
  ): Promise<boolean> {
    if (transitionInProgress) return false
    transitionInProgress = true
    const wasPlaying = isPlaying.value
    const useCrossfade = settings.value.smoothTrackChange && wasPlaying && shouldPlay
    const ready = await loadStandby(track)
    if (!ready) {
      transitionInProgress = false
      return false
    }

    const oldAudio = activeAudio
    const newAudio = standbyAudio
    newAudio.currentTime = 0
    setPlayerVolume(newAudio, useCrossfade ? 0 : 1)

    try {
      if (shouldPlay) await newAudio.play()
      updateStore()
      if (useCrossfade) await crossfadePlayers(oldAudio, newAudio)
      oldAudio.pause()
      oldAudio.currentTime = 0
      activeAudio = newAudio
      standbyAudio = oldAudio
      preloadedTrack = null
      preloadReady = null
      currentTime.value = activeAudio.currentTime
      duration.value = Number.isFinite(activeAudio.duration) ? activeAudio.duration : 0
      isPlaying.value = !activeAudio.paused
      automaticCrossfadeStarted = false
      syncMediaSession()
      transitionInProgress = false
      window.setTimeout(preloadNextTrack, 0)
      return true
    } catch {
      failedTrackIds.add(track.id)
      preloadMessage.value = `《${track.title}》无法加载，正在尝试下一首`
      newAudio.pause()
      transitionInProgress = false
      preloadedTrack = null
      preloadReady = null
      window.setTimeout(() => void next(false), 0)
      return false
    }
    void queue
  }

  async function selectAndPlay(track: Track, queue: Track[]) {
    await switchToTrack(track, queue, () => store.selectTrack(track, queue), true)
  }

  async function next(manual = true) {
    const track = predictNextTrack(manual)
    if (!track) {
      pause()
      seek(0)
      return
    }
    await switchToTrack(track, store.queue, () => {
      store.nextTrack(manual, track.id)
    }, isPlaying.value)
  }

  async function previous() {
    if (activeAudio.currentTime > 5) {
      seek(0)
      return
    }
    const queue = store.queue
    const candidates: Track[] = []
    for (let offset = 1; offset <= queue.length; offset += 1) {
      const index = (store.currentIndex - offset + queue.length) % queue.length
      const candidate = queue[index]
      if (candidate && !failedTrackIds.has(candidate.id)) {
        candidates.push(candidate)
      }
    }
    for (const track of candidates) {
      const switched = await switchToTrack(
        track,
        queue,
        () => store.previousTrack(track.id),
        isPlaying.value,
      )
      if (switched) return
    }
  }

  watch(
    currentTrack,
    (track, previousTrack) => {
      if (!track || transitionInProgress || track.id === preloadedTrack?.id) return
      const resolvedUrl = new URL(track.audioUrl, window.location.href).href
      if (activeAudio.src === resolvedUrl) return
      activeAudio.src = track.audioUrl
      activeAudio.load()
      automaticCrossfadeStarted = false
      syncMediaSession()
      if (previousTrack && isPlaying.value) void play()
    },
    { immediate: true, flush: 'sync' },
  )

  watch(
    () => settings.value.volume,
    () => {
      setPlayerVolume(activeAudio, 1)
    },
    { immediate: true },
  )
  watch(() => settings.value.playMode, clearStandby)
  watch(
    () => settings.value.preloadNextTrack,
    (enabled) => {
      if (!enabled) clearStandby()
    },
  )
  watch(
    () => store.queue.map((track) => track.id).join('|'),
    () => {
      failedTrackIds.clear()
      clearStandby()
    },
  )
  watch(isPlaying, syncMediaSession)

  function handleTimeUpdate(audio: HTMLAudioElement) {
    if (audio !== activeAudio) return
    currentTime.value = audio.currentTime
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      const remaining = audio.duration - audio.currentTime
      const preloadThreshold = Math.max(12, Math.min(30, audio.duration * 0.1))
      if (remaining <= preloadThreshold) preloadNextTrack()
      if (
        settings.value.smoothTrackChange
        && preloadedTrack
        && !automaticCrossfadeStarted
        && remaining <= CROSSFADE_DURATION / 1000
      ) {
        automaticCrossfadeStarted = true
        void next(false)
      }
    }
    if ('mediaSession' in navigator && Number.isFinite(audio.duration)) {
      try {
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate,
          position: Math.min(audio.currentTime, audio.duration),
        })
      } catch {
        // Browsers can reject position updates during media transitions.
      }
    }
  }

  players.forEach((audio) => {
    audio.addEventListener('timeupdate', () => handleTimeUpdate(audio))
    audio.addEventListener('durationchange', () => {
      if (audio === activeAudio) duration.value = Number.isFinite(audio.duration) ? audio.duration : 0
    })
    audio.addEventListener('play', () => {
      if (audio === activeAudio) {
        isPlaying.value = true
        void startBeatAnalysis()
      }
    })
    audio.addEventListener('pause', () => {
      if (audio === activeAudio && !transitionInProgress) {
        isPlaying.value = false
        stopBeatAnalysis()
      }
    })
    audio.addEventListener('ended', () => {
      if (audio === activeAudio && !transitionInProgress) void next(false)
    })
    audio.addEventListener('error', () => {
      if (audio !== activeAudio || transitionInProgress) return
      const failedTrack = currentTrack.value
      if (failedTrack) {
        failedTrackIds.add(failedTrack.id)
        preloadMessage.value = `《${failedTrack.title}》无法加载，正在尝试下一首`
      }
      store.errorMessage = ''
      if (settings.value.skipOnError && store.queue.length > 1) {
        window.setTimeout(() => void next(false), 80)
      }
    })
  })

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => void play())
    navigator.mediaSession.setActionHandler('pause', pause)
    navigator.mediaSession.setActionHandler('previoustrack', () => void previous())
    navigator.mediaSession.setActionHandler('nexttrack', () => void next())
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined) seek(details.seekTime)
    })
    navigator.mediaSession.setActionHandler('seekbackward', (details) =>
      seek(activeAudio.currentTime - (details.seekOffset || 10)),
    )
    navigator.mediaSession.setActionHandler('seekforward', (details) =>
      seek(activeAudio.currentTime + (details.seekOffset || 10)),
    )
  }

  onBeforeUnmount(() => {
    stopBeatAnalysis()
    void audioContext?.close()
    players.forEach((audio) => {
      audio.pause()
      audio.src = ''
    })
  })

  return {
    audio: activeAudio,
    beatLevel,
    preloadMessage,
    play,
    pause,
    toggle,
    seek,
    next,
    previous,
    selectAndPlay,
  }
}
