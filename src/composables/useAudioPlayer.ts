import { onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { usePlayerStore } from '../stores/player'
import { loadLyricsText } from '../services/lyrics'
import type { Track } from '../types/music'

const CROSSFADE_DURATION = 650
type PreloadDirection = 'previous' | 'next'

interface PreloadSlot {
  audio: HTMLAudioElement
  direction: PreloadDirection
  ready: Promise<boolean> | null
  track: Track | null
}

function createAudio(preload: HTMLMediaElement['preload']) {
  const audio = new Audio()
  audio.preload = preload
  audio.crossOrigin = 'anonymous'
  return audio
}

export function useAudioPlayer() {
  const store = usePlayerStore()
  const { currentTrack, isPlaying, currentTime, duration, settings } = storeToRefs(store)
  const players = [createAudio('metadata'), createAudio('auto'), createAudio('auto')] as const
  let activeAudio = players[0]
  const preloadSlots: Record<PreloadDirection, PreloadSlot> = {
    previous: {
      audio: players[1],
      direction: 'previous',
      ready: null,
      track: null,
    },
    next: {
      audio: players[2],
      direction: 'next',
      ready: null,
      track: null,
    },
  }
  const beatLevel = ref(0)
  const preloadMessage = ref('')
  const failedTrackIds = new Set<string>()
  let transitionInProgress = false
  let automaticCrossfadeStarted = false
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let frequencyData: Uint8Array<ArrayBuffer> | null = null
  let beatFrame = 0
  let energyFloor = 0.08
  let volumeAnimation = 0

  function findCachedTrack(direction: PreloadDirection): Track | null {
    const track = preloadSlots[direction].track
    if (!track || track.id === currentTrack.value?.id || failedTrackIds.has(track.id)) return null
    return track
  }

  function predictTrack(direction: PreloadDirection, manual = false): Track | null {
    const queue = store.queue
    if (!queue.length) return null
    if (direction === 'next' && settings.value.playMode === 'single' && !manual) return currentTrack.value

    const cachedTrack = findCachedTrack(direction)
    if (cachedTrack) return cachedTrack

    if (direction === 'next' && settings.value.playMode === 'shuffle' && queue.length > 1) {
      const candidates = queue.filter(
        (track) => track.id !== currentTrack.value?.id && !failedTrackIds.has(track.id),
      )
      return candidates[Math.floor(Math.random() * candidates.length)] ?? null
    }

    for (let offset = 1; offset <= queue.length; offset += 1) {
      const index = direction === 'next'
        ? store.currentIndex + offset
        : store.currentIndex - offset
      if (settings.value.playMode === 'sequence' && (index >= queue.length || index < 0)) return null
      const track = queue[(index + queue.length) % queue.length]
      if (track && !failedTrackIds.has(track.id)) return track
    }
    return null
  }

  function predictNextTrack(manual = false): Track | null {
    return predictTrack('next', manual)
  }

  function predictPreviousTrack(): Track | null {
    return predictTrack('previous', true)
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

  function clearSlot(slot: PreloadSlot) {
    slot.track = null
    slot.ready = null
    slot.audio.pause()
    slot.audio.removeAttribute('src')
    slot.audio.load()
  }

  function clearPreloads() {
    clearSlot(preloadSlots.previous)
    clearSlot(preloadSlots.next)
  }

  function findSlotByTrack(track: Track): PreloadSlot | null {
    return Object.values(preloadSlots).find((slot) => slot.track?.id === track.id) ?? null
  }

  function loadSlot(direction: PreloadDirection, track: Track): Promise<boolean> {
    const slot = preloadSlots[direction]
    if (slot.track?.id === track.id && slot.ready) return slot.ready

    const duplicateSlot = findSlotByTrack(track)
    if (duplicateSlot && duplicateSlot !== slot) clearSlot(duplicateSlot)

    clearSlot(slot)
    slot.track = track
    slot.audio.volume = 0
    slot.ready = new Promise<boolean>((resolve) => {
      const cleanup = () => {
        slot.audio.removeEventListener('canplay', handleReady)
        slot.audio.removeEventListener('loadeddata', handleReady)
        slot.audio.removeEventListener('error', handleError)
      }
      const handleReady = () => {
        cleanup()
        resolve(true)
      }
      const handleError = () => {
        cleanup()
        failedTrackIds.add(track.id)
        preloadMessage.value = `已跳过暂时无法播放的歌曲，正在继续播放`
        slot.track = null
        slot.ready = null
        resolve(false)
        scheduleAdjacentPreload()
      }
      slot.audio.addEventListener('canplay', handleReady, { once: true })
      slot.audio.addEventListener('loadeddata', handleReady, { once: true })
      slot.audio.addEventListener('error', handleError, { once: true })
    })
    slot.audio.src = track.audioUrl
    slot.audio.load()
    void preloadCover(track.cover)
    void preloadLyrics(track.lyricsUrl)
    return slot.ready
  }

  function preloadAdjacentTracks() {
    if (!settings.value.preloadNextTrack || transitionInProgress) return
    const previousTrack = predictPreviousTrack()
    const nextTrack = predictNextTrack()
    if (previousTrack && previousTrack.id !== currentTrack.value?.id) {
      void loadSlot('previous', previousTrack)
    } else {
      clearSlot(preloadSlots.previous)
    }
    if (nextTrack && nextTrack.id !== currentTrack.value?.id) {
      void loadSlot('next', nextTrack)
    } else {
      clearSlot(preloadSlots.next)
    }
  }

  function scheduleAdjacentPreload() {
    window.setTimeout(preloadAdjacentTracks, 0)
  }

  function setPlayerVolume(audio: HTMLAudioElement, gain: number) {
    audio.volume = Math.max(0, Math.min(1, settings.value.volume * gain))
  }

  function crossfadePlayers(oldAudio: HTMLAudioElement, newAudio: HTMLAudioElement) {
    const animationId = ++volumeAnimation
    const startedAt = performance.now()
    return new Promise<void>((resolve) => {
      const finish = () => {
        setPlayerVolume(oldAudio, 0)
        setPlayerVolume(newAudio, 1)
        resolve()
      }

      function step(now: number) {
        if (animationId !== volumeAnimation) {
          resolve()
          return
        }
        const progress = Math.min(1, (now - startedAt) / CROSSFADE_DURATION)
        const eased = progress * progress * (3 - 2 * progress)
        setPlayerVolume(oldAudio, 1 - eased)
        setPlayerVolume(newAudio, eased)
        if (progress >= 1) {
          finish()
          return
        }

        if (document.hidden) {
          window.setTimeout(() => step(performance.now()), 32)
          return
        }

        window.requestAnimationFrame(step)
      }

      if (document.hidden) {
        window.setTimeout(() => step(performance.now()), 0)
        return
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
    preloadSlots.previous.audio.pause()
    preloadSlots.next.audio.pause()
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

  function commitActiveAudio(track: Track, queue: Track[]) {
    volumeAnimation += 1
    transitionInProgress = false
    automaticCrossfadeStarted = false
    setPlayerVolume(activeAudio, 1)
    store.selectTrack(track, queue)
    currentTime.value = activeAudio.currentTime
    duration.value = Number.isFinite(activeAudio.duration) ? activeAudio.duration : 0
    syncMediaSession()
  }

  async function playActiveAudio() {
    try {
      setPlayerVolume(activeAudio, 1)
      await activeAudio.play()
      isPlaying.value = true
      store.errorMessage = ''
      void startBeatAnalysis()
      scheduleAdjacentPreload()
      return true
    } catch (error) {
      isPlaying.value = false
      const reason = error as DOMException
      if (reason.name === 'NotAllowedError') store.errorMessage = '浏览器阻止了播放，请再次点击播放'
      else if (reason.name === 'NotSupportedError') store.errorMessage = '浏览器无法解码当前音频'
      else if (reason.name !== 'AbortError') store.errorMessage = '当前歌曲无法播放，请稍后再试'
      return false
    }
  }

  function replaceActiveWithSlot(slot: PreloadSlot, direction: PreloadDirection) {
    const oldAudio = activeAudio
    const oldTrack = currentTrack.value
    const newAudio = slot.audio
    const reverseSlot = preloadSlots[direction === 'next' ? 'previous' : 'next']
    const spareAudio = reverseSlot.audio
    activeAudio = newAudio
    slot.audio = spareAudio
    slot.track = null
    slot.ready = null
    reverseSlot.audio = oldAudio
    reverseSlot.track = oldTrack
    reverseSlot.ready = oldTrack ? Promise.resolve(true) : null
    return { oldAudio, oldTrack, newAudio }
  }

  async function switchToTrack(
    track: Track,
    queue: Track[],
    updateStore: () => void,
    shouldPlay: boolean,
    direction: PreloadDirection,
  ): Promise<boolean> {
    if (transitionInProgress) return false
    transitionInProgress = true
    const wasPlaying = isPlaying.value
    const useCrossfade = settings.value.smoothTrackChange && wasPlaying && shouldPlay
    const slot = findSlotByTrack(track) ?? preloadSlots[direction]
    const ready = slot.track?.id === track.id
      ? await (slot.ready ?? Promise.resolve(true))
      : await loadSlot(direction, track)
    if (!ready) {
      transitionInProgress = false
      return false
    }

    const { oldAudio, newAudio } = replaceActiveWithSlot(slot, direction)
    newAudio.currentTime = 0
    setPlayerVolume(newAudio, useCrossfade ? 0 : 1)

    try {
      if (shouldPlay) await newAudio.play()
      updateStore()
      if (useCrossfade) await crossfadePlayers(oldAudio, newAudio)
      oldAudio.pause()
      oldAudio.currentTime = 0
      oldAudio.volume = 0
      currentTime.value = activeAudio.currentTime
      duration.value = Number.isFinite(activeAudio.duration) ? activeAudio.duration : 0
      isPlaying.value = !activeAudio.paused
      automaticCrossfadeStarted = false
      syncMediaSession()
      transitionInProgress = false
      scheduleAdjacentPreload()
      return true
    } catch {
      failedTrackIds.add(track.id)
      preloadMessage.value = `已跳过暂时无法播放的歌曲，正在继续播放`
      newAudio.pause()
      activeAudio = oldAudio
      const reverseSlot = preloadSlots[direction === 'next' ? 'previous' : 'next']
      reverseSlot.audio = newAudio
      reverseSlot.track = null
      reverseSlot.ready = null
      clearSlot(reverseSlot)
      transitionInProgress = false
      window.setTimeout(() => void next(false), 0)
      return false
    }
    void queue
  }

  async function selectAndPlay(track: Track, queue: Track[]) {
    if (transitionInProgress) return
    transitionInProgress = true
    activeAudio.pause()
    const slot = findSlotByTrack(track)
    if (slot) {
      const oldAudio = activeAudio
      const newAudio = slot.audio
      activeAudio = newAudio
      slot.audio = oldAudio
      slot.track = null
      slot.ready = null
      oldAudio.pause()
      oldAudio.currentTime = 0
      oldAudio.volume = 0
    } else {
      clearPreloads()
      activeAudio.src = track.audioUrl
      activeAudio.load()
      void preloadCover(track.cover)
      void preloadLyrics(track.lyricsUrl)
    }
    activeAudio.currentTime = 0
    commitActiveAudio(track, queue)
    const played = await playActiveAudio()
    if (!played && settings.value.skipOnError && queue.length > 1) {
      failedTrackIds.add(track.id)
      window.setTimeout(() => void next(false), 80)
    }
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
    }, isPlaying.value, 'next')
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
        'previous',
      )
      if (switched) return
    }
  }

  watch(
    currentTrack,
    (track, previousTrack) => {
      if (!track || transitionInProgress) return
      const resolvedUrl = new URL(track.audioUrl, window.location.href).href
      if (activeAudio.src === resolvedUrl) return
      activeAudio.src = track.audioUrl
      activeAudio.load()
      automaticCrossfadeStarted = false
      syncMediaSession()
      scheduleAdjacentPreload()
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
  watch(() => settings.value.playMode, clearPreloads)
  watch(
    () => settings.value.preloadNextTrack,
    (enabled) => {
      if (!enabled) clearPreloads()
      else scheduleAdjacentPreload()
    },
  )
  watch(
    () => store.queue.map((track) => track.id).join('|'),
    () => {
      failedTrackIds.clear()
      clearPreloads()
      scheduleAdjacentPreload()
    },
  )
  watch(isPlaying, syncMediaSession)

  function handleTimeUpdate(audio: HTMLAudioElement) {
    if (audio !== activeAudio) return
    currentTime.value = audio.currentTime
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      const remaining = audio.duration - audio.currentTime
      if (
        settings.value.smoothTrackChange
        && preloadSlots.next.track
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
      if (audio === activeAudio) {
        duration.value = Number.isFinite(audio.duration) ? audio.duration : 0
        scheduleAdjacentPreload()
      }
    })
    audio.addEventListener('canplay', () => {
      if (audio === activeAudio) scheduleAdjacentPreload()
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
        preloadMessage.value = `已跳过暂时无法播放的歌曲，正在继续播放`
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
