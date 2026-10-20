import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ListeningStatsSection from '../components/ListeningStatsSection.vue'
import type { ListeningStatsSummary } from '../platform/web/listening-history'

function summary(): ListeningStatsSummary {
  return {
    totalListenedSeconds: 1860,
    totalQualifiedPlays: 9,
    frequentTracks: 3,
    cachedTracks: 2,
    cacheBytes: 120000,
    storageAvailable: true,
    trackedTracks: Array.from({ length: 8 }, (_, index) => ({
      key: `track-${index}`,
      title: `歌曲 ${index}`,
      artist: '歌手',
      qualifiedPlays: index,
      listenedSeconds: index * 30,
      lastPlayedAt: 1,
      frequent: index >= 2,
    })),
  }
}

describe('listening statistics settings', () => {
  it('shows bounded, ordered frequent songs and explains local caching', () => {
    const wrapper = mount(ListeningStatsSection, { props: { stats: summary(), onClear: vi.fn() } })
    expect(wrapper.findAll('.listening-ranking li')).toHaveLength(5)
    expect(wrapper.find('.listening-ranking li').text()).toContain('歌曲 7')
    expect(wrapper.text()).toContain('31 分钟')
    expect(wrapper.text()).toContain('统计仅保存在此浏览器')
    wrapper.unmount()
  })

  it('requires confirmation and prevents repeated clearing until the request settles', async () => {
    let finish!: () => void
    const onClear = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const wrapper = mount(ListeningStatsSection, { props: { stats: summary(), onClear } })
    const button = wrapper.get('button')
    await button.trigger('click')
    expect(onClear).not.toHaveBeenCalled()
    expect(button.text()).toContain('再次点击清除')
    await button.trigger('click')
    expect(onClear).toHaveBeenCalledOnce()
    expect(button.attributes('disabled')).toBeDefined()
    finish()
    await flushPromises()
    expect(button.attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('reports storage and clear failures without hiding existing statistics', async () => {
    const stats = { ...summary(), storageAvailable: false }
    const wrapper = mount(ListeningStatsSection, {
      props: { stats, onClear: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    expect(wrapper.get('[role="status"]').text()).toContain('本地存储暂不可用')
    await wrapper.get('button').trigger('click')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('清除未完成')
    expect(wrapper.findAll('.listening-ranking li')).toHaveLength(5)
    wrapper.unmount()
  })

  it('keeps a retry control after a partial clear emptied the displayed counts', async () => {
    let rejectClear!: (reason: Error) => void
    const onClear = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectClear = reject
        }),
    )
    const wrapper = mount(ListeningStatsSection, { props: { stats: summary(), onClear } })
    await wrapper.get('button').trigger('click')
    await wrapper.get('button').trigger('click')
    await wrapper.setProps({
      stats: { ...summary(), trackedTracks: [], cachedTracks: 0, cacheBytes: 0 },
    })
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    rejectClear(new Error('storage unavailable'))
    await flushPromises()
    expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
    await wrapper.get('button').trigger('click')
    await wrapper.get('button').trigger('click')
    expect(onClear).toHaveBeenCalledTimes(2)
    rejectClear(new Error('storage unavailable'))
    await flushPromises()
    wrapper.unmount()
  })
})
