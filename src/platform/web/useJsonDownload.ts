import { nextTick, onBeforeUnmount, readonly, ref } from 'vue'

/** Browser-only download ownership; generated object URLs never outlive this scope. */
export function useJsonDownload() {
  const exporting = ref(false)
  const error = ref<string | null>(null)
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  let disposed = false

  function release(url: string): void {
    const timer = pending.get(url)
    if (timer !== undefined) clearTimeout(timer)
    pending.delete(url)
    URL.revokeObjectURL(url)
  }

  async function download(createData: () => unknown, filename: string): Promise<boolean> {
    if (disposed || exporting.value) return false
    exporting.value = true
    error.value = null
    let anchor: HTMLAnchorElement | null = null
    let url: string | null = null
    try {
      await nextTick()
      if (disposed) return false
      if (typeof URL.createObjectURL !== 'function') throw new Error('Download unavailable')
      const json = JSON.stringify(createData(), null, 2)
      if (json === undefined) throw new Error('No export data')
      const blob = new Blob([`${json}\n`], { type: 'application/json;charset=utf-8' })
      url = URL.createObjectURL(blob)
      anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.rel = 'noopener'
      anchor.hidden = true
      document.body.appendChild(anchor)
      anchor.click()
      // Let the browser accept the download before revoking its backing Blob.
      const acceptedUrl = url
      pending.set(
        acceptedUrl,
        setTimeout(() => release(acceptedUrl), 1000),
      )
      url = null
      return true
    } catch {
      if (!disposed) error.value = '导出失败，请重试或换个浏览器下载。'
      return false
    } finally {
      anchor?.remove()
      if (url !== null) URL.revokeObjectURL(url)
      exporting.value = false
    }
  }

  function clearError(): void {
    error.value = null
  }

  onBeforeUnmount(() => {
    disposed = true
    for (const url of pending.keys()) release(url)
  })

  return { download, exporting: readonly(exporting), error: readonly(error), clearError }
}
