import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebAudioBackend } from '../platform/web/audio-backend'

function defineProp(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { configurable: true, get: () => value })
}

describe('web audio backend', () => {
  let volume = 1

  beforeEach(() => {
    volume = 1
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  function backend(backgroundSafe = false, onSpectrumLost?: () => void) {
    return createWebAudioBackend({
      backgroundSafe,
      initialVolume: volume,
      onSpectrumLost,
    })
  }

  it('opens one playing channel plus two spares', () => {
    const audio = backend()
    expect(audio.channels()).toHaveLength(3)
    expect(audio.active()).toBe(audio.channels()[0])
    audio.dispose()
  })

  it('multiplies the channel gain by the master volume', () => {
    const audio = backend()
    const channel = audio.active()
    const element = audio.elementOf(channel)

    channel.setGain(0.5)
    expect(element.volume).toBeCloseTo(0.5, 5)

    // 总音量以传进来的实参为准,后端不该回头去读构造时那个闭包
    audio.setMasterVolume(0.4)
    expect(element.volume).toBeCloseTo(0.2, 5)
    // 总音量变了,这一路自己的增益不该被改写
    expect(channel.gain()).toBeCloseTo(0.5, 5)
    audio.dispose()
  })

  it('swallows a rejected currentTime write and retries it on the next duration event', () => {
    // 单曲循环在 ended 事件里立刻 seek(0),部分浏览器此刻会抛 InvalidStateError。
    // 后端契约要求方法不抛错,否则异常会从 ended 监听里窜出去,重播直接变成停播
    const audio = backend()
    const channel = audio.active()
    const element = audio.elementOf(channel)
    defineProp(element, 'duration', 120)

    let accepted: number | null = null
    let rejecting = true
    Object.defineProperty(element, 'currentTime', {
      configurable: true,
      get: () => accepted ?? 0,
      set: (value: number) => {
        if (rejecting) throw new DOMException('seek rejected', 'InvalidStateError')
        accepted = value
      },
    })

    expect(() => channel.seek(30)).not.toThrow()
    expect(accepted).toBeNull()

    // 欠着的跳转要在下一次时长事件里补上
    rejecting = false
    element.dispatchEvent(new Event('durationchange'))
    expect(accepted).toBe(30)
    audio.dispose()
  })

  it('remembers a seek made before the duration is known and applies it later', () => {
    const audio = backend()
    const channel = audio.active()
    const element = audio.elementOf(channel)
    defineProp(element, 'duration', Number.NaN)

    channel.seek(42)
    // 时长未知时写 currentTime 不生效,先记下来
    expect(element.currentTime).toBe(0)

    defineProp(element, 'duration', 100)
    element.dispatchEvent(new Event('durationchange'))
    expect(element.currentTime).toBe(42)
    audio.dispose()
  })

  it('clamps a seek to the known duration', () => {
    const audio = backend()
    const channel = audio.active()
    const element = audio.elementOf(channel)
    defineProp(element, 'duration', 30)

    channel.seek(500)
    expect(element.currentTime).toBe(30)
    channel.seek(-5)
    expect(element.currentTime).toBe(0)
    audio.dispose()
  })

  it('forwards media events to whoever subscribed on the channel', () => {
    const audio = backend()
    const channel = audio.active()
    const element = audio.elementOf(channel)
    const onEnded = vi.fn()
    const stop = channel.on('ended', onEnded)

    element.dispatchEvent(new Event('ended'))
    expect(onEnded).toHaveBeenCalledTimes(1)

    stop()
    element.dispatchEvent(new Event('ended'))
    expect(onEnded).toHaveBeenCalledTimes(1)
    audio.dispose()
  })

  it('keeps the channel handle and its subscriptions alive across a tainted rebuild', () => {
    // 跨源音频被 Web Audio 污染后必须换掉元素。这是后端内部的事:
    // 上层持有的句柄、以及挂在句柄上的订阅都必须照常工作
    const audio = backend()
    const channel = audio.active()
    const before = audio.elementOf(channel)
    const onPlay = vi.fn()
    channel.on('play', onPlay)
    channel.setGain(0.5)

    audio.degradeForTaint(before)

    const after = audio.elementOf(channel)
    expect(after).not.toBe(before)
    // 句柄没变
    expect(audio.active()).toBe(channel)
    // 订阅跟着迁移到新元素上
    after.dispatchEvent(new Event('play'))
    expect(onPlay).toHaveBeenCalledTimes(1)
    // 旧元素不再出声,也不再触发回调
    before.dispatchEvent(new Event('play'))
    expect(onPlay).toHaveBeenCalledTimes(1)
    // 增益也带过去了
    expect(after.volume).toBeCloseTo(0.5, 5)
    audio.dispose()
  })

  it('drops the spectrum capability once a source has been tainted', () => {
    const onSpectrumLost = vi.fn()
    const audio = backend(false, onSpectrumLost)
    expect(audio.supportsSpectrum()).toBe(true)

    audio.degradeForTaint(audio.elementOf(audio.active()))

    expect(audio.supportsSpectrum()).toBe(false)
    expect(onSpectrumLost).toHaveBeenCalledTimes(1)

    // 再污染一次不重复通知
    audio.degradeForTaint(audio.elementOf(audio.active()))
    expect(onSpectrumLost).toHaveBeenCalledTimes(1)
    audio.dispose()
  })

  it('reports no overlap and no spectrum in background-safe mode', () => {
    const audio = backend(true)
    expect(audio.supportsOverlap()).toBe(false)
    expect(audio.supportsSpectrum()).toBe(false)
    audio.dispose()
  })

  it('mounts the playing channel into the document only in background-safe mode', () => {
    const plain = backend(false)
    plain.prepareActive()
    expect(document.body.querySelector('audio')).toBeNull()
    plain.dispose()

    const safe = backend(true)
    safe.prepareActive()
    expect(document.body.querySelector('audio')).toBe(safe.elementOf(safe.active()))

    // 换出声通道后挂载跟着走
    const spare = safe.channels()[1]!
    safe.setActive(spare)
    safe.prepareActive()
    expect(document.body.querySelector('audio')).toBe(safe.elementOf(spare))

    safe.dispose()
    expect(document.body.querySelector('audio')).toBeNull()
  })

  it('reports readiness and failure from the underlying element', () => {
    const audio = backend()
    const channel = audio.active()
    const element = audio.elementOf(channel)
    vi.spyOn(element, 'load').mockImplementation(() => {})
    channel.load('/song.mp3')

    defineProp(element, 'readyState', 0)
    expect(channel.canStart()).toBe(false)

    defineProp(element, 'readyState', HTMLMediaElement.HAVE_CURRENT_DATA)
    expect(channel.canStart()).toBe(true)
    expect(channel.failed()).toBe(false)

    defineProp(element, 'error', { code: 2 })
    expect(channel.canStart()).toBe(false)
    expect(channel.failed()).toBe(true)
    // 错误归一成平台无关的原因。没有音频地址时那个原因优先级更高,所以上面先挂了源
    expect(channel.classifyFailure(new Error('boom'))).toBe('network')
    audio.dispose()
  })

  it('clears the source on release so the download stops', () => {
    const audio = backend()
    const channel = audio.active()
    const element = audio.elementOf(channel)
    const load = vi.spyOn(element, 'load').mockImplementation(() => {})

    channel.load('/song.mp3')
    expect(element.getAttribute('src')).toBe('/song.mp3')

    channel.release()
    expect(element.hasAttribute('src')).toBe(false)
    expect(load).toHaveBeenCalled()
    audio.dispose()
  })
})
