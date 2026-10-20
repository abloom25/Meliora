import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useTrackShare } from '../composables/useTrackShare'

describe('track sharing clipboard fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(document, 'execCommand')
  })

  it('rejects a failed legacy copy and removes its temporary textarea', async () => {
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    })
    const { copyText } = useTrackShare({
      currentTrack: ref(null),
      onTriggerHaptic: vi.fn(),
      onShowNotice: vi.fn(),
    })
    await expect(copyText('share')).rejects.toThrow('Clipboard copy failed')
    expect(document.querySelector('textarea')).toBeNull()
  })
})
