import { describe, expect, it } from 'vitest'
import {
  emptyQueueJourney,
  canResumePlayback,
  peekJourneyTrack,
  prepareQueueJourney,
  sanitizePlaybackSession,
  visitQueueTrack,
} from '../core/playback/session'

describe('playback session rules', () => {
  it('allows renewed URLs only for the same stable platform song', () => {
    const id = 'meting:v2:tencent:song:abc'
    expect(canResumePlayback(id, '/old?token=1', { id, audioUrl: '/new?token=2' })).toBe(true)
    expect(
      canResumePlayback(id, '/same', { id: 'meting:v2:tencent:song:other', audioUrl: '/same' }),
    ).toBe(false)
    const resourceId = 'meting:v2:tencent:resource:/asset'
    expect(canResumePlayback(resourceId, '/old', { id: resourceId, audioUrl: '/new' })).toBe(false)
    expect(canResumePlayback('local:1', '/old', { id: 'local:1', audioUrl: '/new' })).toBe(false)
  })
  it('finishes a shuffle round without repeats or rejection sampling', () => {
    const ids = ['a', 'b', 'c', 'd']
    let journey = visitQueueTrack(emptyQueueJourney(), 'a', 'select')
    let current = 'a'
    const visited = [current]
    for (let index = 0; index < 3; index += 1) {
      journey = prepareQueueJourney(journey, ids, current, () => 0)
      const target = peekJourneyTrack(journey, ids, current, 'shuffle', 'next', true, () => false)!
      expect(peekJourneyTrack(journey, ids, current, 'shuffle', 'next', true, () => false)).toBe(
        target,
      )
      visited.push(target)
      journey = visitQueueTrack(journey, target, 'next')
      current = target
    }
    expect(new Set(visited).size).toBe(4)
    journey = prepareQueueJourney(journey, ids, current, () => 0)
    expect(peekJourneyTrack(journey, ids, current, 'shuffle', 'next', true, () => false)).not.toBe(
      current,
    )
  })

  it('follows actual history backward and forward and lets play-next override forward history', () => {
    const ids = ['a', 'b', 'c', 'd']
    let journey = emptyQueueJourney()
    for (const id of ['a', 'd', 'b']) journey = visitQueueTrack(journey, id, 'next')
    expect(peekJourneyTrack(journey, ids, 'b', 'shuffle', 'previous', true, () => false)).toBe('d')
    journey = visitQueueTrack(journey, 'd', 'previous')
    expect(peekJourneyTrack(journey, ids, 'd', 'shuffle', 'next', true, () => false)).toBe('b')
    journey.priority = ['c']
    expect(peekJourneyTrack(journey, ids, 'd', 'shuffle', 'next', true, () => false)).toBe('c')
    journey = visitQueueTrack(journey, 'c', 'next')
    expect(journey.history).toEqual(['a', 'd', 'c'])
  })

  it('skips unavailable candidates without consuming the stable random plan', () => {
    let journey = visitQueueTrack(emptyQueueJourney(), 'a', 'select')
    journey = prepareQueueJourney(journey, ['a', 'b', 'c'], 'a', () => 0)
    expect(
      peekJourneyTrack(journey, ['a', 'b', 'c'], 'a', 'shuffle', 'next', true, (id) => id === 'b'),
    ).toBe('c')
    expect(
      peekJourneyTrack(journey, ['a', 'b', 'c'], 'a', 'shuffle', 'next', true, () => false),
    ).toBe('b')
  })

  it('validates persisted queue, position, history and round against the queue', () => {
    expect(sanitizePlaybackSession({ version: 9 })).toBeNull()
    const restored = sanitizePlaybackSession({
      version: 1,
      queueIds: ['a', 'a', '', 'b'],
      customQueue: true,
      currentTrackId: 'a',
      audioUrl: '/a.mp3',
      position: 42.5,
      journey: {
        history: ['gone', 'a', 'b'],
        historyIndex: 1,
        remaining: ['b', 'gone'],
        played: ['a'],
        priority: ['b', 'gone'],
      },
    })!
    expect(restored.queueIds).toEqual(['a', 'b'])
    expect(restored.position).toBe(42.5)
    expect(restored.journey).toEqual({
      history: ['a', 'b'],
      historyIndex: 0,
      remaining: ['b'],
      played: ['a'],
      priority: ['b'],
    })
    expect(
      sanitizePlaybackSession({ ...restored, currentTrackId: 'gone', position: Infinity })
        ?.position,
    ).toBe(0)
  })

  it('returns the latest successful track when the currently displayed target failed to start', () => {
    let journey = visitQueueTrack(emptyQueueJourney(), 'a', 'select')
    journey = visitQueueTrack(journey, 'c', 'next')
    expect(
      peekJourneyTrack(
        journey,
        ['a', 'b', 'c', 'd'],
        'd',
        'shuffle',
        'previous',
        true,
        () => false,
      ),
    ).toBe('c')
  })

  it('migrates every persisted Meting identity to the stable song ID', () => {
    const oldId =
      'meting:netease:playlist123:7:https://old-api.test?server=netease&type=url&id=123&token=old'
    const id = 'meting:v2:netease:song:123'
    const restored = sanitizePlaybackSession({
      version: 1,
      queueIds: [oldId],
      currentTrackId: oldId,
      position: 18,
      journey: {
        history: [oldId],
        historyIndex: 0,
        remaining: [oldId],
        played: [oldId],
        priority: [oldId],
      },
    })!
    expect(restored.currentTrackId).toBe(id)
    expect(restored.queueIds).toEqual([id])
    expect(restored.journey).toEqual({
      history: [id],
      historyIndex: 0,
      remaining: [id],
      played: [id],
      priority: [id],
    })
    expect(restored.position).toBe(18)
  })
})
