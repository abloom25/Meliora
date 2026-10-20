import { describe, expect, it } from 'vitest'
import {
  createBeatComparisonRecorder,
  exportBeatComparisonData,
  type BeatComparisonExportContext,
} from '../core/analysis/beat-comparison-export'
import {
  createBeatComparisonSample,
  createBeatComparisonSnapshot,
  type BeatComparisonSample,
} from '../core/analysis/beat-comparison'
import { createBeatTimelineBuffer } from '../core/analysis/beat-timeline'

function sample(time = 1000): BeatComparisonSample {
  const value = createBeatComparisonSample(
    {
      sampledAtMs: time,
      level: 0.3,
      sustain: 0.2,
      rawLevel: 0.8,
      rawSustain: 0.7,
      readyMix: 1,
      playbackSeconds: 5,
      sampleSeconds: 4.9,
      delayMs: 100,
      playing: true,
      seeking: false,
      canHighlight: true,
      reason: 'ready',
    },
    1,
    { basic: null, 'beat-this-small': null, 'beat-this-standard': null },
  )
  value.candidates = {
    basic: { level: 0.5, sustain: 0.2 },
    'beat-this-small': { level: 0.6, sustain: 0.2 },
    'beat-this-standard': { level: 0.7, sustain: 0.2 },
  }
  return value
}

describe('beat comparison recording export', () => {
  it('bounds the recording by count and wall-clock age even when media seeks backwards', () => {
    const recorder = createBeatComparisonRecorder()
    for (let index = 0; index <= 20000; index += 1)
      recorder.append({ ...sample(index), playbackSeconds: index % 100 }, index % 2, 'basic', 1)
    expect(recorder.stats()).toMatchObject({
      sampleCount: 20000,
      totalSampleCount: 20001,
      droppedSampleCount: 1,
      droppedByCapacity: 1,
      retainedStartSequence: 2,
      truncated: true,
    })
    recorder.append(sample(700001), 3, 'basic', 1)
    expect(recorder.stats()).toMatchObject({
      sampleCount: 1,
      droppedSampleCount: 20001,
      droppedByAge: 20000,
      retainedStartMs: 700001,
      startedAtMs: 0,
    })
    recorder.clear()
    expect(recorder.stats()).toMatchObject({
      sampleCount: 0,
      totalSampleCount: 0,
      truncated: false,
      startedAtMs: null,
    })
  })

  it('captures immutable sample epochs, modes and playback speed without filling old nulls', () => {
    const recorder = createBeatComparisonRecorder()
    const input = sample()
    input.candidates['beat-this-small'] = null
    recorder.append(input, 4, 'basic', 1)
    input.candidates['beat-this-small'] = { level: 1, sustain: 1 }
    input.actual.level = 0
    recorder.append(sample(1033), 5, 'beat-this-standard', 2)
    const data = exportBeatComparisonData(createBeatComparisonSnapshot(), recorder.read(), {
      playbackRate: 3,
    })
    expect(data.observedSamples[0]).toMatchObject({
      sequence: 1,
      epoch: 4,
      actualMode: 'basic',
      playbackRate: 1,
      actual: { level: 0.3 },
    })
    expect(data.observedSamples[0]!.candidates['beat-this-small']).toBeNull()
    expect(data.observedSamples[1]).toMatchObject({
      epoch: 5,
      actualMode: 'beat-this-standard',
      playbackRate: 2,
    })
    expect(data.context.exportTimeSettings.playbackRate).toBe(3)
    expect(data.recording.epochs).toHaveLength(2)
  })

  it('whitelists context, observations, metadata and status without exposing URLs or raw errors', () => {
    const secret = 'CANARY-SIGNED-SOURCE-SECRET'
    const recorder = createBeatComparisonRecorder()
    const input = sample()
    Object.assign(input, { source: secret, audioUrl: secret, headers: { authorization: secret } })
    Object.assign(input.actual, { source: secret, error: secret })
    recorder.append(input, 1, 'basic', 1)
    const snapshot = createBeatComparisonSnapshot()
    snapshot.routes[1]!.error = secret
    const context = {
      title: '歌曲',
      artist: '歌手',
      appVersion: 'test',
      source: secret,
      trackId: secret,
      error: secret,
      exportedAtIso: '2026-10-19T05:00:00.000Z',
    } as BeatComparisonExportContext
    const recording = recorder.read()
    Object.assign(recording.stats, { source: secret })
    const report = exportBeatComparisonData(snapshot, recording, context)
    expect(JSON.stringify(report)).not.toContain(secret)
    expect(report.context.title).toBe('歌曲')
    expect(report.routes[1]!.model?.version).toBe('beat-this-small0-v1')
    expect(report.exportedAtIso).toBe('2026-10-19T05:00:00.000Z')
    expect(report.semantics.actualIsGroundTruth).toBe(false)
    expect(report.schemaVersion).toBe(2)
    expect(report.routes.map((route) => route.mode)).toEqual([
      'basic',
      'beat-this-small',
      'beat-this-standard',
    ])
  })

  it.each(['basic', 'beat-this-small', 'beat-this-standard'] as const)(
    'exports %s live timeline segments alongside candidate output',
    (mode) => {
      const live = createBeatTimelineBuffer(30, 0.5)
      live.completedRanges = [
        { startSeconds: 4, endSeconds: 5 },
        { startSeconds: 9, endSeconds: 10 },
      ]
      live.levels[1][8] = 0.8
      live.levels[1][18] = NaN
      live.sustain[8] = Infinity
      const own = createBeatTimelineBuffer(30, 0.5)
      own.completedRanges = [{ startSeconds: 15, endSeconds: 16 }]
      const snapshot = createBeatComparisonSnapshot()
      const routeIndex = snapshot.routes.findIndex((route) => route.mode === mode)
      snapshot.routes[routeIndex]!.timeline = own
      const report = exportBeatComparisonData(
        snapshot,
        createBeatComparisonRecorder().read(),
        {},
        new Map([[mode, live]]),
      )
      const timelines = report.routes[routeIndex]!.timelines
      expect(timelines.map((timeline) => timeline.origin)).toEqual(['comparison', 'live'])
      expect(timelines[1]!.segments).toHaveLength(2)
      expect(timelines[1]!.segments[0]!.firstFrame).toBe(8)
      expect(timelines[1]!.segments[0]!.levels[1]).toHaveLength(3)
      expect(Array.isArray(timelines[1]!.segments[0]!.levels[1])).toBe(true)
      expect(timelines[1]!.segments[0]!.sustain[0]).toBeNull()
      expect(timelines[1]!.segments[1]!.levels[1]![0]).toBeNull()
      expect(report.invalidNumberCount).toBe(2)
      expect(
        JSON.parse(JSON.stringify(report)).routes[routeIndex].timelines[1].completedRanges,
      ).toEqual(live.completedRanges)
    },
  )

  it('summarizes contemporaneous availability without bridging seeks, pauses or large gaps', () => {
    const recorder = createBeatComparisonRecorder()
    recorder.append(sample(0), 1, 'basic', 1)
    recorder.append(sample(100), 1, 'basic', 1)
    recorder.append(sample(900), 1, 'basic', 1)
    const paused = sample(1000)
    paused.actual.playing = false
    recorder.append(paused, 1, 'basic', 1)
    recorder.append(sample(1100), 2, 'basic', 1)
    const missing = sample(1200)
    missing.candidates.basic = null
    recorder.append(missing, 2, 'basic', 1)
    const report = exportBeatComparisonData(createBeatComparisonSnapshot(), recorder.read(), {})
    expect(report.coverageSummary).toMatchObject({
      observedSampleCount: 6,
      commonSampleCount: 5,
      playingSampleCount: 5,
      commonPlayingSampleCount: 4,
      commonPlayingSeconds: 0.1,
    })
    expect(report.samplingIntervalsMs.maximum).toBe(800)
    expect(report.coverageSummary.commonPlayingFraction).toBe(0.8)
    expect(report).not.toHaveProperty('winner')
    expect(report).not.toHaveProperty('accuracy')
  })

  it('keeps unavailable model data null and exports whitelisted warm-session timings', () => {
    const recorder = createBeatComparisonRecorder()
    const input = sample()
    input.candidates['beat-this-small'] = null
    recorder.append(input, 1, 'basic', 1)
    input.candidates['beat-this-small'] = { level: 1, sustain: 1 }
    const snapshot = createBeatComparisonSnapshot()
    snapshot.routes[1]!.metrics = {
      totalMs: 500,
      initializationMs: 0,
      inferenceMs: 100,
      sessionReused: true,
      backend: 'wasm',
      featureFrames: 1500,
      reusedFeatureFrames: 300,
      cacheOrigin: 'persistent',
      cacheReadyMs: 32,
      cacheReadMs: 12,
      decodeMs: 0,
      cacheOnly: true,
    }
    Object.assign(snapshot.routes[1]!.metrics, { source: 'CANARY-PRIVATE-URL' })
    const report = exportBeatComparisonData(snapshot, recorder.read(), {})
    expect(report.observedSamples[0]!.candidates['beat-this-small']).toBeNull()
    expect(report.coverageSummary.commonSampleCount).toBe(0)
    expect(report.coverageSummary.requiredModes).toEqual([
      'basic',
      'beat-this-small',
      'beat-this-standard',
    ])
    expect(report.routes[1]!.lastBuildMetrics).toEqual({
      totalMs: 500,
      initializationMs: 0,
      inferenceMs: 100,
      sessionReused: true,
      backend: 'wasm',
      featureFrames: 1500,
      reusedFeatureFrames: 300,
      cacheOrigin: 'persistent',
      cacheReadyMs: 32,
      cacheReadMs: 12,
      decodeMs: 0,
      cacheOnly: true,
      fetchMs: null,
      featureResidentBytes: null,
      featurePeakResidentBytes: null,
      featureInputBytes: null,
      hashMs: null,
      modelPreparationMs: null,
      encodedBytes: null,
      pcmBytes: null,
    })
    expect(JSON.stringify(report)).not.toContain('CANARY-PRIVATE-URL')
  })
})
