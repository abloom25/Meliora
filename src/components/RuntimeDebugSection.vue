<script setup lang="ts">
  import { computed } from 'vue'
  import type { RuntimeDebugSnapshot, RuntimeRequestPhase } from '../core/diagnostics/runtime-debug'

  const props = defineProps<{ runtime: RuntimeDebugSnapshot | null }>()
  const requests = computed(() => [...(props.runtime?.requests ?? [])].reverse())
  const resources = computed(() => [...(props.runtime?.resources ?? [])].reverse())
  const phases: Record<RuntimeRequestPhase, string> = {
    pending: '进行中',
    completed: '已收到响应',
    failed: '失败',
    cancelled: '已取消',
  }
  function number(value: number | null | undefined, digits = 0): string {
    return value !== null && value !== undefined && Number.isFinite(value)
      ? value.toFixed(digits)
      : '不可用'
  }
  function bytes(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '不可用'
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`
    return `${Math.round(value)} B`
  }
</script>

<template>
  <div class="runtime-debug">
    <p v-if="!runtime" class="runtime-empty">仅在调试面板可见时采集，尚无运行数据。</p>
    <template v-else>
      <section aria-label="页面运行状态">
        <h3>页面与网络</h3>
        <dl class="runtime-details">
          <div>
            <dt>页面可见</dt>
            <dd>{{ runtime.page.visible ? '是' : '否' }}</dd>
          </div>
          <div>
            <dt>视口 / 像素比例</dt>
            <dd>
              {{ runtime.page.width }} × {{ runtime.page.height }} /
              {{ number(runtime.page.dpr, 2) }}
            </dd>
          </div>
          <div>
            <dt>逻辑处理器</dt>
            <dd>{{ number(runtime.page.hardwareConcurrency) }}</dd>
          </div>
          <div>
            <dt>浏览器网络状态</dt>
            <dd>
              {{
                runtime.network.online === null
                  ? '不可用'
                  : runtime.network.online
                    ? '在线'
                    : '离线'
              }}
            </dd>
          </div>
          <div>
            <dt>连接类型 / 有效类型</dt>
            <dd>
              {{ runtime.network.connectionType ?? '不可用' }} /
              {{ runtime.network.effectiveType ?? '不可用' }}
            </dd>
          </div>
          <div>
            <dt>估计 RTT</dt>
            <dd>
              {{ number(runtime.network.rttMs)
              }}<template v-if="runtime.network.rttMs !== null"> ms</template>
            </dd>
          </div>
          <div>
            <dt>估计下行带宽</dt>
            <dd>
              {{ number(runtime.network.downlinkMbps, 1)
              }}<template v-if="runtime.network.downlinkMbps !== null"> Mbps</template>
            </dd>
          </div>
          <div>
            <dt>节省流量偏好</dt>
            <dd>
              {{
                runtime.network.saveData === null
                  ? '不可用'
                  : runtime.network.saveData
                    ? '开启'
                    : '关闭'
              }}
            </dd>
          </div>
        </dl>
        <p class="runtime-note">在线状态不代表目标服务器可达；连接指标由浏览器估计。</p>
      </section>
      <section aria-label="内存与运行性能">
        <h3>内存与运行性能</h3>
        <dl class="runtime-details">
          <div>
            <dt>JS 堆已用 / 已分配</dt>
            <dd>
              {{ bytes(runtime.memory?.usedBytes) }} / {{ bytes(runtime.memory?.allocatedBytes) }}
            </dd>
          </div>
          <div>
            <dt>本次 JS 堆采样峰值</dt>
            <dd>{{ bytes(runtime.sampledHeapPeakBytes) }}</dd>
          </div>
          <div>
            <dt>JS 堆上限</dt>
            <dd>{{ bytes(runtime.memory?.limitBytes) }}</dd>
          </div>
          <div>
            <dt>预分析 PCM 缓存</dt>
            <dd>
              {{ bytes(runtime.audioCache?.pcmBytes)
              }}<template v-if="runtime.audioCache">
                · {{ runtime.audioCache.pcmEntries }} 首</template
              >
            </dd>
          </div>
          <div>
            <dt>压缩音频缓存</dt>
            <dd>
              {{ bytes(runtime.audioCache?.encodedBytes)
              }}<template v-if="runtime.audioCache">
                · {{ runtime.audioCache.encodedEntries }} 首</template
              >
            </dd>
          </div>
          <div>
            <dt>DOM 元素数</dt>
            <dd>{{ number(runtime.domElements) }}</dd>
          </div>
          <div>
            <dt>最近采样帧率</dt>
            <dd>{{ runtime.fps === null ? '等待帧采样' : `${number(runtime.fps, 1)} fps` }}</dd>
          </div>
          <div>
            <dt>观测到的长任务</dt>
            <dd>
              {{
                runtime.longTasks
                  ? `${runtime.longTasks.count} 次 · ${number(runtime.longTasks.totalMs)} ms`
                  : '浏览器未提供'
              }}
            </dd>
          </div>
          <div>
            <dt>最长任务</dt>
            <dd>
              {{ number(runtime.longTasks?.maxMs)
              }}<template v-if="runtime.longTasks"> ms</template>
            </dd>
          </div>
          <div>
            <dt>站点存储已用 / 配额</dt>
            <dd>
              {{
                runtime.storageState === 'pending'
                  ? '读取估计值…'
                  : `${bytes(runtime.storage?.usageBytes)} / ${bytes(runtime.storage?.quotaBytes)}`
              }}
            </dd>
          </div>
        </dl>
        <p class="runtime-note">
          JS 堆为浏览器可选估计，采样峰值仅覆盖本次可见观测，可能遗漏瞬时峰值，不完整包含 Worker /
          GPU。音频缓存仅计已缓存 PCM 与压缩音频，不含在途 Worker
          和模型。存储是本站点的估计用量与配额，不是磁盘剩余空间。DOM 每 10 秒、存储每 30 秒采样。
        </p>
        <p class="runtime-note">
          帧率来自可见页面的动画帧回调；长任务只计本次观测期间浏览器报告的 ≥50 ms 主线程任务。
        </p>
      </section>
      <section aria-label="HTTP 传输观察">
        <h3>
          HTTP 传输 <small>最近 {{ requests.length }} / 30 条</small>
        </h3>
        <p class="runtime-note">
          仅记录开启后经 httpFetch 发起的请求；耗时截至响应头返回，不含正文下载。失败状态包含 HTTP
          错误。
        </p>
        <p v-if="!requests.length" class="runtime-empty">本次尚未观测到 HTTP 请求。</p>
        <ol v-else class="runtime-list">
          <li v-for="request in requests" :key="request.id">
            <div class="runtime-row">
              <strong>{{ request.label }}</strong
              ><span>{{ phases[request.phase] }}</span>
            </div>
            <p>
              #{{ request.id }} · {{ number(request.elapsedMs) }} ms<template
                v-if="request.status !== null"
              >
                · HTTP {{ request.status }}</template
              >
            </p>
          </li>
        </ol>
      </section>
      <section aria-label="页面资源耗时">
        <h3>
          页面资源 <small>最近 {{ resources.length }} / 30 条</small>
        </h3>
        <p class="runtime-note">
          当前页面 Resource Timing 可见的已完成资源；不保证覆盖
          Worker、小窗和仍在传输的资源。两份列表都不是完整的浏览器网络记录。
        </p>
        <p v-if="!runtime.resourceTimingSupported" class="runtime-empty">
          浏览器未提供资源耗时观察。
        </p>
        <p v-else-if="!resources.length" class="runtime-empty">本次尚无已完成的页面资源。</p>
        <ol v-else class="runtime-list">
          <li v-for="resource in resources" :key="resource.id">
            <div class="runtime-row">
              <strong>{{ resource.label }}</strong
              ><span>{{ number(resource.durationMs) }} ms</span>
            </div>
            <p>
              {{ resource.initiator }} · 传输 {{ bytes(resource.transferBytes) }} · 解码后
              {{ bytes(resource.decodedBytes)
              }}<template v-if="resource.responseStatus !== null">
                · HTTP {{ resource.responseStatus }}</template
              >
            </p>
          </li>
        </ol>
        <p class="runtime-note">
          大小或状态可能受跨源权限与浏览器能力限制；未公开或为 0
          时记为不可用，不据此判断缓存命中。地址、参数和认证信息不记录。
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped lang="scss">
  .runtime-debug {
    color: var(--text);
    font-size: 0.68rem;
    font-variant-numeric: tabular-nums;
  }
  section {
    margin-inline: 20px;
    padding-block: 16px;
  }
  section + section {
    border-top: 1px solid rgba(255, 255, 255, 0.09);
  }
  h3 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin: 0 0 10px;
    font-size: 0.78rem;
    font-weight: 550;
  }
  h3 small {
    color: var(--text-subtle);
    font-size: 0.6rem;
    font-weight: 400;
  }
  .runtime-details {
    margin: 0;
  }
  .runtime-details > div {
    display: grid;
    grid-template-columns: minmax(7em, auto) minmax(0, 1fr);
    gap: 8px 12px;
    padding-block: 4px;
  }
  dt {
    color: var(--text-subtle);
    font-size: 0.61rem;
  }
  dd {
    margin: 0;
    text-align: end;
    color: var(--text-muted);
    font-size: 0.64rem;
    overflow-wrap: anywhere;
  }
  .runtime-note {
    margin: 8px 0 0;
    font-size: 0.6rem;
    line-height: 1.7;
    color: var(--text-subtle);
  }
  .runtime-empty {
    padding: 12px 20px;
    font-size: 0.65rem;
    line-height: 1.7;
    color: var(--text-subtle);
    text-align: center;
  }
  .runtime-list {
    list-style: none;
    padding: 0;
    margin: 10px 0 0;
    max-block-size: 23rem;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .runtime-list li {
    padding-block: 9px;
  }
  .runtime-list li + li {
    border-top: 1px solid rgba(255, 255, 255, 0.055);
  }
  .runtime-row {
    display: flex;
    justify-content: space-between;
    gap: 10px;
  }
  .runtime-row strong {
    font-weight: 500;
  }
  .runtime-row span {
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .runtime-list p {
    margin: 5px 0 0;
    font-size: 0.59rem;
    color: var(--text-subtle);
    line-height: 1.6;
  }
  @media (max-width: 420px) {
    section {
      margin-inline: 14px;
    }
  }
  @media (prefers-contrast: more) {
    dt,
    dd,
    .runtime-note,
    .runtime-list p,
    .runtime-row span {
      color: var(--text);
    }
  }
</style>
