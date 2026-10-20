import type { BeatAnalysisMode } from '../types'
import { BEAT_FLASH_RATE_STEPS } from './beat-envelope'
import {
  BEAT_COMPARISON_MODES,
  type BeatComparisonMode,
  type BeatComparisonSample,
  type BeatComparisonSnapshot,
} from './beat-comparison'
import { BEAT_THIS_MODELS } from './beat-this-models'
import { normalizeBeatRanges, type BeatTimeline } from './beat-timeline'

export const BEAT_COMPARISON_RECORDING_MAX_SAMPLES = 20_000
export const BEAT_COMPARISON_RECORDING_MAX_AGE_MS = 600_000

export interface BeatComparisonExportContext {
  title?: string
  artist?: string
  appVersion?: string
  playbackRate?: number
  requestedSampleIntervalMs?: number
  beatBrightness?: number
  beatVisualDelayMs?: number
  beatFlashEnabled?: boolean
  exportedAtIso?: string
}

export interface BeatComparisonRecordingStats {
  sampleCount: number
  totalSampleCount: number
  droppedSampleCount: number
  truncated: boolean
  droppedByAge: number
  droppedByCapacity: number
  startedAtMs: number | null
  retainedStartMs: number | null
  retainedEndMs: number | null
  retainedStartSequence: number | null
  retainedEndSequence: number | null
}

export interface BeatComparisonRecordedSample {
  sequence: number
  sessionTimeMs: number
  epoch: number
  actualMode: BeatAnalysisMode
  playbackRate: number
  sample: BeatComparisonSample
}

export interface BeatComparisonRecording {
  stats: BeatComparisonRecordingStats
  entries: readonly BeatComparisonRecordedSample[]
}

/** A non-reactive, bounded journal. Seeking cannot extend its wall-clock retention. */
export function createBeatComparisonRecorder() {
  let entries: BeatComparisonRecordedSample[] = []
  let head = 0
  let total = 0
  let droppedByAge = 0
  let droppedByCapacity = 0
  let startedAtMs: number | null = null
  let lastTimestamp = -Infinity

  function stats(): BeatComparisonRecordingStats {
    const first = entries[head]
    const last = entries.at(-1)
    return {
      sampleCount: entries.length - head,
      totalSampleCount: total,
      droppedSampleCount: droppedByAge + droppedByCapacity,
      truncated: droppedByAge + droppedByCapacity > 0,
      droppedByAge,
      droppedByCapacity,
      startedAtMs,
      retainedStartMs: first?.sample.sampledAtMs ?? null,
      retainedEndMs: last?.sample.sampledAtMs ?? null,
      retainedStartSequence: first?.sequence ?? null,
      retainedEndSequence: last?.sequence ?? null,
    }
  }

  return {
    append(
      sample: BeatComparisonSample,
      epoch: number,
      actualMode: BeatAnalysisMode,
      playbackRate: number,
    ): boolean {
      if (!Number.isFinite(sample.sampledAtMs) || sample.sampledAtMs <= lastTimestamp) return false
      startedAtMs ??= sample.sampledAtMs
      lastTimestamp = sample.sampledAtMs
      total += 1
      const copyValue = (mode: BeatComparisonMode) =>
        sample.candidates[mode] ? { ...sample.candidates[mode] } : null
      entries.push({
        sequence: total,
        sessionTimeMs: sample.sampledAtMs - startedAtMs,
        epoch,
        actualMode,
        playbackRate,
        sample: {
          ...sample,
          actual: {
            ...sample.actual,
            ...(sample.actual.timing ? { timing: { ...sample.actual.timing } } : {}),
          },
          candidates: {
            basic: copyValue('basic'),
            'beat-this-small': copyValue('beat-this-small'),
            'beat-this-standard': copyValue('beat-this-standard'),
          },
        },
      })
      while (
        entries[head]!.sample.sampledAtMs <
        sample.sampledAtMs - BEAT_COMPARISON_RECORDING_MAX_AGE_MS
      ) {
        head += 1
        droppedByAge += 1
      }
      while (entries.length - head > BEAT_COMPARISON_RECORDING_MAX_SAMPLES) {
        head += 1
        droppedByCapacity += 1
      }
      if (head > 1024) {
        entries = entries.slice(head)
        head = 0
      }
      return true
    },
    stats,
    read(): BeatComparisonRecording {
      return { stats: stats(), entries: entries.slice(head) }
    },
    clear(): void {
      entries = []
      head = 0
      total = 0
      droppedByAge = 0
      droppedByCapacity = 0
      startedAtMs = null
      lastTimestamp = -Infinity
    },
  }
}

/** Whitelist every exported field; runtime extras and raw errors never enter the report. */
export function exportBeatComparisonData(
  snapshot: BeatComparisonSnapshot,
  recording: BeatComparisonRecording,
  context: BeatComparisonExportContext,
  liveTimelines: ReadonlyMap<BeatAnalysisMode, BeatTimeline> = new Map(),
) {
  let invalidNumberCount = 0
  const number = (value: number | null | undefined): number | null => {
    if (value === undefined || value === null) return null
    if (Number.isFinite(value)) return value
    invalidNumberCount += 1
    return null
  }
  const text = (value: string | undefined, maximum = 300): string | null =>
    typeof value === 'string' ? value.slice(0, maximum) : null
  const pair = (value: { level: number; sustain: number } | null) =>
    value ? { level: number(value.level), sustain: number(value.sustain) } : null
  const observedSamples = recording.entries.map((entry) => {
    const sample = entry.sample
    const actual = sample.actual
    const timing = actual.timing
    return {
      sequence: entry.sequence,
      sessionTimeMs: number(entry.sessionTimeMs),
      epoch: entry.epoch,
      actualMode: entry.actualMode,
      playbackRate: number(entry.playbackRate),
      sampledAtMs: number(sample.sampledAtMs),
      playbackSeconds: number(sample.playbackSeconds),
      sampleSeconds: number(sample.sampleSeconds),
      flashRate: sample.flashRate,
      candidates: {
        basic: pair(sample.candidates.basic),
        'beat-this-small': pair(sample.candidates['beat-this-small']),
        'beat-this-standard': pair(sample.candidates['beat-this-standard']),
      },
      actual: {
        level: number(actual.level),
        sustain: number(actual.sustain),
        rawLevel: number(actual.rawLevel),
        rawSustain: number(actual.rawSustain),
        readyMix: number(actual.readyMix),
        delayMs: number(actual.delayMs),
        playing: actual.playing,
        seeking: actual.seeking,
        canHighlight: actual.canHighlight,
        reason: actual.reason,
        timing: timing
          ? {
              clockSource: timing.clockSource,
              frameLeadMs: number(timing.frameLeadMs),
              outputOffsetMs: number(timing.outputOffsetMs),
              timelineSource: timing.timelineSource,
              firstAvailableMs: number(timing.firstAvailableMs),
              lastWriteAtMs: number(timing.lastWriteAtMs),
              handoffPending: timing.handoffPending,
            }
          : null,
      },
    }
  })

  const serializeTimeline = (timeline: BeatTimeline, origin: 'comparison' | 'live') => {
    const durationSeconds = number(timeline.durationSeconds)
    const stepSeconds = number(timeline.stepSeconds)
    if (
      durationSeconds === null ||
      stepSeconds === null ||
      durationSeconds <= 0 ||
      stepSeconds <= 0
    )
      return null
    const frameCount = Math.min(
      timeline.sustain.length,
      ...timeline.levels.map((values) => values.length),
    )
    const availableDuration = Math.min(durationSeconds, Math.max(0, frameCount - 1) * stepSeconds)
    const completedRanges = normalizeBeatRanges(
      timeline.completedRanges ?? [
        { startSeconds: 0, endSeconds: timeline.builtUntilSeconds ?? durationSeconds },
      ],
      availableDuration,
    )
    return {
      origin,
      durationSeconds,
      stepSeconds,
      flashRates: [...BEAT_FLASH_RATE_STEPS],
      completedRanges,
      segments: completedRanges.map((range) => {
        // One support sample on each fractional boundary preserves interpolation;
        // completedRanges, not these support samples, define usable media times.
        const firstFrame = Math.max(0, Math.floor(range.startSeconds / stepSeconds))
        const endFrame = Math.min(frameCount, Math.ceil(range.endSeconds / stepSeconds) + 1)
        return {
          startSeconds: range.startSeconds,
          endSeconds: range.endSeconds,
          firstFrame,
          levels: timeline.levels.map((values) =>
            Array.from(values.subarray(firstFrame, endFrame), number),
          ),
          sustain: Array.from(timeline.sustain.subarray(firstFrame, endFrame), number),
        }
      }),
    }
  }
  const routes = BEAT_COMPARISON_MODES.map((mode) => {
    const route = snapshot.routes.find((candidate) => candidate.mode === mode)
    const id =
      mode === 'beat-this-small' ? 'small' : mode === 'beat-this-standard' ? 'standard' : null
    const live = liveTimelines.get(mode)
    const timelines = [
      route?.timeline ? serializeTimeline(route.timeline, 'comparison') : null,
      live && live !== route?.timeline ? serializeTimeline(live, 'live') : null,
    ].filter((timeline) => timeline !== null)
    return {
      mode,
      model: id
        ? { id, label: BEAT_THIS_MODELS[id].label, version: BEAT_THIS_MODELS[id].version }
        : null,
      algorithm: id
        ? 'Beat This! beats blended with basic onset and sustain analysis'
        : 'HPSS, tempo ruler and beat envelope',
      status: route?.status ?? 'idle',
      phase: route?.phase ?? 'idle',
      lastBuildDurationIncludingPreparationMs: number(route?.elapsedMs),
      lastBuildMetrics: route?.metrics
        ? {
            totalMs: number(route.metrics.totalMs),
            initializationMs: number(route.metrics.initializationMs),
            inferenceMs: number(route.metrics.inferenceMs),
            sessionReused: route.metrics.sessionReused,
            featureFrames: number(route.metrics.featureFrames),
            reusedFeatureFrames: number(route.metrics.reusedFeatureFrames),
            featureResidentBytes: number(route.metrics.featureResidentBytes),
            featurePeakResidentBytes: number(route.metrics.featurePeakResidentBytes),
            featureInputBytes: number(route.metrics.featureInputBytes),
            fetchMs: number(route.metrics.fetchMs),
            hashMs: number(route.metrics.hashMs),
            cacheReadMs: number(route.metrics.cacheReadMs),
            cacheReadyMs: number(route.metrics.cacheReadyMs),
            decodeMs: number(route.metrics.decodeMs),
            modelPreparationMs: number(route.metrics.modelPreparationMs),
            encodedBytes: number(route.metrics.encodedBytes),
            pcmBytes: number(route.metrics.pcmBytes),
            cacheOnly: route.metrics.cacheOnly === true,
            cacheOrigin: ['none', 'memory', 'persistent'].includes(route.metrics.cacheOrigin ?? '')
              ? route.metrics.cacheOrigin
              : null,
            backend: ['webgpu', 'wasm'].includes(route.metrics.backend ?? '')
              ? route.metrics.backend
              : null,
          }
        : null,
      timelines,
    }
  })

  const validPair = (value: { level: number; sustain: number } | null): boolean =>
    !!value && Number.isFinite(value.level) && Number.isFinite(value.sustain)
  const common = (entry: BeatComparisonRecordedSample): boolean =>
    BEAT_COMPARISON_MODES.every((mode) => validPair(entry.sample.candidates[mode]))
  const playing = (entry: BeatComparisonRecordedSample): boolean =>
    entry.sample.actual.playing && !entry.sample.actual.seeking
  let commonSampleCount = 0
  let playingSampleCount = 0
  let commonPlayingSampleCount = 0
  let commonPlayingSeconds = 0
  const intervals: number[] = []
  const epochs: Array<{
    epoch: number
    actualMode: BeatAnalysisMode
    flashRate: number
    playbackRate: number
    firstSequence: number
    lastSequence: number
    sampleCount: number
  }> = []
  for (let index = 0; index < recording.entries.length; index += 1) {
    const entry = recording.entries[index]!
    const isCommon = common(entry)
    const isPlaying = playing(entry)
    commonSampleCount += Number(isCommon)
    playingSampleCount += Number(isPlaying)
    commonPlayingSampleCount += Number(isCommon && isPlaying)
    const previous = recording.entries[index - 1]
    const sameSegment =
      previous &&
      previous.epoch === entry.epoch &&
      previous.actualMode === entry.actualMode &&
      previous.sample.flashRate === entry.sample.flashRate &&
      previous.playbackRate === entry.playbackRate
    const gap = previous ? entry.sample.sampledAtMs - previous.sample.sampledAtMs : 0
    if (sameSegment && gap > 0 && Number.isFinite(gap)) {
      intervals.push(gap)
      if (gap <= 500 && isCommon && isPlaying && common(previous) && playing(previous))
        commonPlayingSeconds += gap / 1000
    }
    const epoch = epochs.at(-1)
    if (!sameSegment || !epoch)
      epochs.push({
        epoch: entry.epoch,
        actualMode: entry.actualMode,
        flashRate: entry.sample.flashRate,
        playbackRate: entry.playbackRate,
        firstSequence: entry.sequence,
        lastSequence: entry.sequence,
        sampleCount: 1,
      })
    else {
      epoch.lastSequence = entry.sequence
      epoch.sampleCount += 1
    }
  }
  intervals.sort((left, right) => left - right)
  const report = {
    schemaVersion: 2,
    kind: 'meliora-beat-comparison',
    exportedAtIso:
      typeof context.exportedAtIso === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(context.exportedAtIso)
        ? context.exportedAtIso
        : null,
    units: {
      mediaTime: 'seconds',
      monotonicTime: 'milliseconds since page performance time origin',
      sessionTime: 'milliseconds since first recorded observation',
      level: 'normalized renderer input before CSS brightness scaling',
    },
    semantics: {
      actualIsGroundTruth: false,
      candidateNullMeans: 'not available at observation time; not silence or a missed beat',
      observedSamples:
        'immutable contemporaneous observations; later analysis never fills historical gaps',
      constructedTimelines:
        'latest retained analysis; may have finished after observations and must not be used to backfill availability',
      timelineSegments:
        'only completed intervals plus interpolation support samples; frame time = (firstFrame + index) * stepSeconds',
      routeTiming:
        'last local comparison build, including preparation and cache effects; excludes lease waiting; not a model inference benchmark',
      buildMetrics:
        'initialization includes session creation and validation; inference counts model calls only, excludes feature extraction and basic envelope work; sessionReused refers to the resident worker session',
      coverageSummary:
        'availability only; no beat accuracy, reference labels, quality score or winner is inferred',
      exportTimeSettingsOnly: true,
    },
    context: {
      title: text(context.title),
      artist: text(context.artist),
      appVersion: text(context.appVersion, 80),
      exportTimeSettings: {
        playbackRate: number(context.playbackRate),
        beatBrightness: number(context.beatBrightness),
        beatVisualDelayMs: number(context.beatVisualDelayMs),
        beatFlashEnabled:
          typeof context.beatFlashEnabled === 'boolean' ? context.beatFlashEnabled : null,
      },
      requestedSampleIntervalMs: number(context.requestedSampleIntervalMs),
    },
    recording: {
      sampleCount: recording.stats.sampleCount,
      totalSampleCount: recording.stats.totalSampleCount,
      droppedSampleCount: recording.stats.droppedSampleCount,
      truncated: recording.stats.truncated,
      droppedByAge: recording.stats.droppedByAge,
      droppedByCapacity: recording.stats.droppedByCapacity,
      startedAtMs: number(recording.stats.startedAtMs),
      retainedStartMs: number(recording.stats.retainedStartMs),
      retainedEndMs: number(recording.stats.retainedEndMs),
      retainedStartSequence: recording.stats.retainedStartSequence,
      retainedEndSequence: recording.stats.retainedEndSequence,
      limits: {
        maxSamples: BEAT_COMPARISON_RECORDING_MAX_SAMPLES,
        maxWallClockAgeMs: BEAT_COMPARISON_RECORDING_MAX_AGE_MS,
      },
      epochs,
    },
    samplingIntervalsMs: {
      count: intervals.length,
      minimum: intervals[0] ?? null,
      median: intervals.length ? intervals[Math.floor(intervals.length / 2)]! : null,
      maximum: intervals.at(-1) ?? null,
      mean: intervals.length
        ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length
        : null,
      scope:
        'adjacent retained observations within the same epoch, mode, flash rate and playback rate',
    },
    coverageSummary: {
      requiredModes: [...BEAT_COMPARISON_MODES],
      observedSampleCount: recording.entries.length,
      commonSampleCount,
      commonObservedFraction: recording.entries.length
        ? commonSampleCount / recording.entries.length
        : null,
      playingSampleCount,
      commonPlayingSampleCount,
      commonPlayingFraction: playingSampleCount
        ? commonPlayingSampleCount / playingSampleCount
        : null,
      commonPlayingSeconds,
      maximumJoinedGapMs: 500,
    },
    routes,
    observedSamples,
    invalidNumberCount: 0,
  }
  report.invalidNumberCount = invalidNumberCount
  return report
}

export type BeatComparisonExport = ReturnType<typeof exportBeatComparisonData>
