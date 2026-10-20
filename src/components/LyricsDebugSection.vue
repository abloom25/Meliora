<script setup lang="ts">
  import { computed } from 'vue'
  import { PictureInPicture2 } from '@lucide/vue'
  import type {
    LyricsDebugSnapshot,
    LyricsWindowDebugSnapshot,
  } from '../core/diagnostics/lyrics-debug'
  import type { LyricProviderSource, LyricStatus } from '../core/types'

  const props = withDefaults(
    defineProps<{
      lyrics: LyricsDebugSnapshot | null
      lyricsWindow: LyricsWindowDebugSnapshot | null
      lyricsWindowSupported?: boolean
      hasCurrentTrack?: boolean
    }>(),
    { lyricsWindowSupported: false, hasCurrentTrack: false },
  )
  const emit = defineEmits<{ 'toggle-lyrics-window': [] }>()
  const statusLabels: Record<LyricStatus, string> = {
    idle: '尚未加载',
    loading: '加载中',
    ready: '已就绪',
    empty: '未找到歌词',
    error: '加载失败',
  }
  const sourceLabels: Record<LyricProviderSource, string> = {
    amll: 'AMLL',
    netease: '网易云音乐',
    qq: 'QQ 音乐',
    meting: 'Meting',
    local: '本地歌词',
  }
  const lifecycleLabels: Record<LyricsWindowDebugSnapshot['lifecycle'][number]['event'], string> = {
    opening: '开始打开',
    opened: '已打开',
    closed: '已关闭',
    failed: '打开失败',
    'track-changed': '切换歌曲',
  }
  function sourceLabel(source: LyricProviderSource | null): string {
    return source ? sourceLabels[source] : '未获取'
  }
  function flag(value: boolean | null): string {
    return value === null ? '未获取' : value ? '是' : '否'
  }
  function scheduleLabel(value: LyricsDebugSnapshot['renderSchedule']): string {
    return value === 'frame'
      ? '逐帧扫光'
      : value === 'timer'
        ? '等待歌词边界'
        : value === 'idle'
          ? '已停止'
          : '未获取'
  }
  function fixed(value: number | null, digits = 1): string {
    return value !== null && Number.isFinite(value) ? value.toFixed(digits) : '—'
  }
  function lineLabel(index: number): string {
    return Number.isInteger(index) && index >= 0 ? `第 ${index + 1} 行` : '无'
  }
  function safeFailure(value: string): string {
    return value
      .replace(/https?:\/\/\S+|(?:\/[^\s?]*)?\?[^\s]+/gi, '[地址已隐藏]')
      .replace(/\b(?:token|key|secret|signature|authorization)\s*[:=]\s*\S+/gi, '[凭据已隐藏]')
  }
  const activeLines = computed(() => props.lyrics?.activeLines.slice(0, 3) ?? [])
  const windowStatus = computed(() =>
    !props.lyricsWindow
      ? '尚未获取'
      : props.lyricsWindow.opening
        ? '正在打开'
        : props.lyricsWindow.open
          ? '已打开'
          : '已关闭',
  )
  const canToggleWindow = computed(
    () =>
      !props.lyricsWindow?.opening &&
      (props.lyricsWindow?.open || (props.lyricsWindowSupported && props.hasCurrentTrack)),
  )
  const windowActionLabel = computed(() =>
    props.lyricsWindow?.opening
      ? '正在打开小窗'
      : props.lyricsWindow?.open
        ? '关闭歌词小窗'
        : '打开歌词小窗',
  )
  const lifecycle = computed(() => (props.lyricsWindow?.lifecycle ?? []).slice(-12).reverse())
  function eventAge(atMs: number): string {
    const nowMs = props.lyricsWindow?.sampledAtMs
    if (nowMs === undefined || !Number.isFinite(nowMs) || !Number.isFinite(atMs))
      return '时间未获取'
    return `${(Math.max(0, nowMs - atMs) / 1000).toFixed(1)} 秒前`
  }
</script>

<template>
  <div class="lyrics-debug" aria-live="off">
    <section class="lyrics-debug-section" aria-label="歌词数据">
      <div class="lyrics-debug-heading">
        <h3>歌词数据</h3>
        <span>{{ lyrics ? statusLabels[lyrics.status] : '未获取' }}</span>
      </div>
      <p v-if="!lyrics" class="lyrics-debug-note">
        尚无歌词诊断数据。打开调试后显示实际歌词和渲染状态。
      </p>
      <template v-else>
        <dl class="lyrics-debug-details">
          <div>
            <dt>实际来源</dt>
            <dd>{{ sourceLabel(lyrics.source) }}</dd>
          </div>
          <div>
            <dt>总行数 / 逐字行数</dt>
            <dd>{{ lyrics.lineCount }} / {{ lyrics.wordLineCount }}</dd>
          </div>
          <div>
            <dt>逐字片段</dt>
            <dd>{{ lyrics.wordCount }}</dd>
          </div>
          <div>
            <dt>翻译 / 罗马音 / 和声行</dt>
            <dd>
              {{ lyrics.translationLineCount }} / {{ lyrics.romanLineCount }} /
              {{ lyrics.harmonyLineCount }}
            </dd>
          </div>
          <div>
            <dt>活跃行</dt>
            <dd>
              {{
                lyrics.activeIndices.length ? lyrics.activeIndices.map(lineLabel).join('、') : '无'
              }}
            </dd>
          </div>
        </dl>
        <ol v-if="activeLines.length" class="lyrics-debug-preview" aria-label="实际活跃歌词行">
          <li v-for="line in activeLines" :key="line.index">
            <div>
              <strong>{{ lineLabel(line.index) }}{{ line.background ? ' · 和声' : '' }}</strong
              ><span>{{ fixed(line.timeSeconds, 3) }} s · {{ line.wordCount }} 个逐字片段</span>
            </div>
            <p>{{ line.text.slice(0, 120) || '空行' }}</p>
          </li>
        </ol>
        <p v-else class="lyrics-debug-note">当前没有活跃歌词行；不会用相邻歌词代替。</p>
      </template>
    </section>

    <section class="lyrics-debug-section" aria-label="歌词时钟与渲染">
      <div class="lyrics-debug-heading">
        <h3>时钟与渲染</h3>
        <span>{{ lyrics ? (lyrics.playing ? '播放中' : '已暂停') : '未获取' }}</span>
      </div>
      <p v-if="!lyrics" class="lyrics-debug-note">等待时钟与渲染快照。</p>
      <template v-else>
        <dl class="lyrics-debug-details">
          <div>
            <dt>媒体 / 歌词时钟</dt>
            <dd>{{ fixed(lyrics.mediaSeconds, 3) }} / {{ fixed(lyrics.clockSeconds, 3) }} s</dd>
          </div>
          <div>
            <dt>时钟差值</dt>
            <dd>{{ fixed(lyrics.clockDriftMs) }} ms</dd>
          </div>
          <div>
            <dt>面板活跃 / 逐帧循环</dt>
            <dd>{{ flag(lyrics.panelActive) }} / {{ flag(lyrics.renderLoopRunning) }}</dd>
          </div>
          <div>
            <dt>歌词刷新调度</dt>
            <dd>{{ scheduleLabel(lyrics.renderSchedule) }}</dd>
          </div>
          <div>
            <dt>用户浏览 / 场景保留</dt>
            <dd>{{ flag(lyrics.userBrowsing) }} / {{ flag(lyrics.sceneHeld) }}</dd>
          </div>
          <div>
            <dt>页面隐藏 / 减少动态效果</dt>
            <dd>{{ flag(lyrics.documentHidden) }} / {{ flag(lyrics.reducedMotion) }}</dd>
          </div>
          <div>
            <dt>歌词动画 / 翻译</dt>
            <dd>{{ flag(lyrics.animationEnabled) }} / {{ flag(lyrics.translationEnabled) }}</dd>
          </div>
        </dl>
        <dl v-if="lyrics.engine" class="lyrics-debug-details lyrics-debug-engine">
          <div>
            <dt>挂载 / 暂存 / 可见行</dt>
            <dd>
              {{ lyrics.engine.mountedLineCount }} / {{ lyrics.engine.stagedLineCount }} /
              {{ lyrics.engine.visibleLineCount }}
            </dd>
          </div>
          <div>
            <dt>动画行 / 待执行帧</dt>
            <dd>
              {{ lyrics.engine.animatingLineCount }} / {{ flag(lyrics.engine.frameScheduled) }}
            </dd>
          </div>
          <div>
            <dt>滚动模式 / 锚点</dt>
            <dd>
              {{ lyrics.engine.scrollMode === 'follow' ? '跟随播放' : '手动浏览' }} /
              {{ lineLabel(lyrics.engine.anchorIndex) }}
            </dd>
          </div>
          <div>
            <dt>滚动 / 浏览偏移</dt>
            <dd>{{ fixed(lyrics.engine.offset) }} / {{ fixed(lyrics.engine.browseOffset) }} px</dd>
          </div>
          <div>
            <dt>视口高度 / 滚动速度</dt>
            <dd>
              {{ fixed(lyrics.engine.viewportHeight) }} px /
              {{ fixed(lyrics.engine.flingVelocity) }}
            </dd>
          </div>
        </dl>
        <p v-else class="lyrics-debug-note">歌词渲染引擎尚未挂载，不能读取可见行与动画数。</p>
      </template>
    </section>

    <section class="lyrics-debug-section" aria-label="歌词小窗诊断">
      <div class="lyrics-debug-heading">
        <h3>歌词小窗</h3>
        <span>{{ windowStatus }}</span>
      </div>
      <button
        type="button"
        class="lyrics-debug-action"
        :disabled="!canToggleWindow"
        @click="emit('toggle-lyrics-window')"
      >
        <PictureInPicture2 :size="13" aria-hidden="true" />{{ windowActionLabel }}
      </button>
      <p v-if="!lyricsWindowSupported && !lyricsWindow?.open" class="lyrics-debug-note">
        当前环境不支持歌词小窗。
      </p>
      <p v-else-if="!hasCurrentTrack && !lyricsWindow?.open" class="lyrics-debug-note">
        请先选择歌曲，再测试小窗。
      </p>
      <p v-if="!lyricsWindow" class="lyrics-debug-note">
        尚无小窗快照；不根据窗口按钮状态推测是否打开。
      </p>
      <template v-else>
        <dl class="lyrics-debug-details">
          <div>
            <dt>窗口类型</dt>
            <dd>
              {{
                lyricsWindow.kind === 'document-pip'
                  ? '文档画中画'
                  : lyricsWindow.kind === 'popup'
                    ? '独立弹窗'
                    : '未创建'
              }}
            </dd>
          </div>
          <div>
            <dt>尺寸</dt>
            <dd>{{ fixed(lyricsWindow.width, 0) }} × {{ fixed(lyricsWindow.height, 0) }}</dd>
          </div>
          <div>
            <dt>窗口可见 / 节点就绪</dt>
            <dd>{{ flag(lyricsWindow.visible) }} / {{ flag(lyricsWindow.nodesReady) }}</dd>
          </div>
          <div>
            <dt>歌词状态 / 来源</dt>
            <dd>
              {{ statusLabels[lyricsWindow.status] }} / {{ sourceLabel(lyricsWindow.source) }}
            </dd>
          </div>
          <div>
            <dt>挂载行 / 当前歌词</dt>
            <dd>
              {{ lyricsWindow.mountedLineCount }} /
              {{ lineLabel(lyricsWindow.renderedActiveIndex) }}
            </dd>
          </div>
          <div>
            <dt>逐字绑定槽（从 0 计）</dt>
            <dd>
              {{ lyricsWindow.activeSlots.length ? lyricsWindow.activeSlots.join('、') : '无' }}
            </dd>
          </div>
          <div>
            <dt>逐字循环 / 绑定字节点</dt>
            <dd>{{ flag(lyricsWindow.karaokeRunning) }} / {{ lyricsWindow.animatedWordCount }}</dd>
          </div>
          <div>
            <dt>小窗刷新调度</dt>
            <dd>{{ scheduleLabel(lyricsWindow.renderSchedule) }}</dd>
          </div>
          <div>
            <dt>滚动动画数</dt>
            <dd>{{ lyricsWindow.scrollAnimationCount }}</dd>
          </div>
          <div>
            <dt>媒体 / 小窗时钟</dt>
            <dd>
              {{ fixed(lyricsWindow.mediaSeconds, 3) }} /
              {{ fixed(lyricsWindow.clockSeconds, 3) }} s
            </dd>
          </div>
          <div>
            <dt>动画 / 减少动态效果</dt>
            <dd>
              {{ flag(lyricsWindow.animationEnabled) }} / {{ flag(lyricsWindow.reducedMotion) }}
            </dd>
          </div>
        </dl>
        <p v-if="lyricsWindow.lastFailure" class="lyrics-debug-note">
          最近失败：{{ safeFailure(lyricsWindow.lastFailure) }}
        </p>
        <ol
          v-if="lifecycle.length"
          class="lyrics-debug-lifecycle"
          aria-label="本次调试观察到的小窗事件"
        >
          <li v-for="(entry, index) in lifecycle" :key="`${entry.atMs}:${index}`">
            <span>{{ lifecycleLabels[entry.event] }}</span
            ><time>{{ eventAge(entry.atMs) }}</time>
          </li>
        </ol>
        <p v-else class="lyrics-debug-note">本次调试尚未观察到小窗生命周期事件。</p>
        <p class="lyrics-debug-note">仅记录调试开启期间的最近 12 条事件。</p>
      </template>
    </section>
  </div>
</template>

<style scoped lang="scss">
  .lyrics-debug {
    min-inline-size: 0;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .lyrics-debug-section {
    margin-inline: 20px;
    padding-block: 16px;
  }
  .lyrics-debug-section + .lyrics-debug-section {
    border-top: 1px solid rgba(255, 255, 255, 0.09);
  }
  .lyrics-debug-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 12px;
    min-block-size: 30px;
  }
  .lyrics-debug-heading h3 {
    margin: 0;
    font-size: 0.78rem;
    font-weight: 550;
  }
  .lyrics-debug-heading > span {
    color: var(--text-subtle);
    font-size: 0.64rem;
  }
  .lyrics-debug-note {
    margin: 5px 0 0;
    color: var(--text-subtle);
    font-size: 0.64rem;
    line-height: 1.65;
    overflow-wrap: anywhere;
  }
  .lyrics-debug-details {
    margin: 10px 0 0;
  }
  .lyrics-debug-details > div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 6px 10px;
    padding-block: 4px;
    align-items: baseline;
  }
  .lyrics-debug-details dt {
    color: var(--text-subtle);
    font-size: 0.6rem;
    line-height: 1.5;
  }
  .lyrics-debug-details dd {
    margin: 0;
    color: var(--text-muted);
    text-align: end;
    font-size: 0.64rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .lyrics-debug-engine {
    padding-top: 6px;
    border-top: 1px solid rgba(255, 255, 255, 0.055);
  }
  .lyrics-debug-preview {
    padding: 0;
    margin: 12px 0 0;
    list-style: none;
  }
  .lyrics-debug-preview li {
    padding-block: 8px;
  }
  .lyrics-debug-preview li + li {
    border-top: 1px solid rgba(255, 255, 255, 0.055);
  }
  .lyrics-debug-preview li > div {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    color: var(--text-subtle);
    font-size: 0.59rem;
  }
  .lyrics-debug-preview strong {
    font-weight: 500;
    color: var(--text-muted);
  }
  .lyrics-debug-preview p {
    margin: 5px 0 0;
    font-size: 0.74rem;
    line-height: 1.7;
    overflow-wrap: anywhere;
  }
  .lyrics-debug-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-block-size: 32px;
    margin-top: 7px;
    padding: 6px 10px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    color: var(--text-muted);
    font: inherit;
    font-size: 0.65rem;
    cursor: pointer;
    transition: background 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .lyrics-debug-action:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .lyrics-debug-action:not(:disabled):hover {
    background: rgba(255, 255, 255, 0.12);
  }
  .lyrics-debug-action:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: 3px;
  }
  .lyrics-debug-lifecycle {
    margin: 12px 0 0;
    padding: 8px 0 0;
    border-top: 1px solid rgba(255, 255, 255, 0.055);
    list-style: none;
  }
  .lyrics-debug-lifecycle li {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    min-block-size: 1.6rem;
    color: var(--text-muted);
    font-size: 0.63rem;
  }
  .lyrics-debug-lifecycle time {
    color: var(--text-subtle);
  }
  @media (max-width: 420px) {
    .lyrics-debug-section {
      margin-inline: 14px;
    }
    .lyrics-debug-details > div {
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
      gap: 5px 8px;
    }
  }
  @media (pointer: coarse) {
    .lyrics-debug-action {
      min-block-size: 40px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .lyrics-debug-action {
      transition: none;
    }
  }
  @media (prefers-contrast: more) {
    .lyrics-debug-note,
    .lyrics-debug-details dt,
    .lyrics-debug-heading > span,
    .lyrics-debug-lifecycle time {
      color: var(--text);
    }
    .lyrics-debug-action {
      border-color: currentColor;
    }
  }
</style>
