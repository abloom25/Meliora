# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1-rc.3] - 2026-06-18

### Added

- 主题色提取走 Web Worker：新增 `src/workers/theme-extractor.worker.ts` + `src/utils/theme-core.ts`(DOM-free 纯算法),通过 `OffscreenCanvas` + `transferable ImageBitmap` 零复制传输,主线程仅负责 DOM I/O,大幅降低切歌瞬间的主线程长任务
- Worker 路径自带 1.5s 超时与 `onerror` 兜底,失败时自动回退到主线程同步实现,行为与之前一致
- 主封面"已就绪"二态建模:`useCoverCache` 新增 `mainCoverReadyTrackId` 与 `markMainCoverReady` / `resetMainCover`,与曲库级 `loadedCovers` 严格分离,切歌时主封面重新走 fade-in 但抽屉小封面不闪现
- 高频 CSS 变量直写通道:`useBeatAnalyser` 新增 `getBeatTargets` 选项,`--beat-level` 每帧通过 `el.style.setProperty` 写入 `artwork-background` / `background-overlay` 两个目标节点,跳过根 `:style` 与 Vue reactivity
- `--accent` / `--accent-soft` 注册为 `@property` 颜色类型,在支持的浏览器(Chrome 85+ / Safari 16.4+)上由 GPU 原生过渡,JS 动画作为降级
- `TrackList` 搜索输入接入 180ms 防抖(`debouncedQuery`),输入框值与外部过滤解耦,长曲库下输入手感显著平滑
- 节拍可视化挂接 `visibilitychange` 监听,标签页进入后台时自动暂停 RAF 循环、回到前台时无缝恢复
- `PlayerControls` 时间格式支持 ≥1 小时的曲目(`H:MM:SS`),原先只渲染 `M:SS`
- `agent.md` 增补 §3.4 高频 DOM 直写接口、§3.7 DOM-free 共享纯模块、§4.1 CSS 变量分类约束、§5 Worker / 合成层 / 二态缓存等专项规范

### Changed

- `useAudioPlayer` 切歌路径重构:取消串行 fade-out 等待,改为 microtask 推迟 `syncMediaSession` / 旧 audio 收尾 / 邻曲预加载,同步阶段只做 audio 引用切换 + reactivity 写入,连续点击下一曲的感知延迟显著降低
- 切歌时仅在 `currentTime > 0.01` 时才重置时间轴,避免对预加载 slot 做无效浏览器调用
- `useBeatAnalyser` 改用模块级**共享 `AudioContext`**,`MediaElementAudioSourceNode` 统一缓存到 `WeakMap`,从根本上消除组件重建后对同一 `<audio>` 节点重复 `createMediaElementSource` 抛出的 `InvalidStateError`
- `--beat-level` 写入加入 `lastValue` 去重与 `isConnected` 守卫,跳过相同帧值与已脱离 DOM 的目标节点,避免样式风暴
- `will-change` 不再常驻挂在 `.artwork-background` 上,改为通过 `.beat-active` 条件 class 仅在播放期间启用,暂停 / 空闲时让浏览器回收合成层
- 椭圆封面氛围光去掉 `translate3d(-12%, -12%, 0)`,只保留 `scale`,减少一层不必要的 GPU 合成层位移
- 主封面 `<img>` 加上 `decoding="async"` + `loading="eager"`,抽屉小封面加上 `loading="lazy"` + `decoding="async"`;主封面 `@load` 回调现先 `await image.decode()` 再标记 ready,避免视觉上半解码逐行渲染
- `extractThemeColor` 改为 async API,调用方统一 `await`(原同步版本已迁出到 worker / core 中)
- `TrackList` 滚动追踪 watcher 用 `[tracks.length, tracks[0]?.id]` 替代 `tracks.map(id).join('|')`,消除每次曲库变更的 O(n) 字符串拼接
- `package.json` 补回 `predev` 钩子,`pnpm dev` 启动前自动跑 `generate` 写入应用版本号
- `agent.md` 全面修订:补充 Web Worker 目录约定、CSS 变量写入双通道规范、远程 IO 与预加载超时分类、二态缓存建模、`will-change` 使用守则、Node 22 + pnpm 11 运行环境锁定等

### Fixed

- 修复 `useAudioPlayer` 切歌路径中 `transitionInProgress` 解锁时机错误:之前在 `store.selectTrack` 之前就被置 false,后续 `watch(currentTrack)` 可能误触发重新加载;现在改为先更新 store、再解锁,杜绝循环加载
- 修复 `useLyricsWindow`:歌词小窗被用户关闭后 `lyricsWindow` 引用未清空,下次开窗会复用已关闭对象
- 修复 `LyricsPanel`:目标行 DOM 尚未渲染时直接 `onComplete` 会跳过滚动动画;现在改为 RAF 重试直到节点出现或组件卸载
- 修复 `services/lyrics.ts` 中 `signal.removeEventListener` 可能误删其他请求监听器的隐患:把 `forwardAbort` 引用绑到 cache entry 上精准移除
- 修复 `public/sw.js` Range 请求判定:HTTP header 名按 RFC 9110 大小写不敏感,改用 `headers.get('range')` + `trim().length > 0` 判空,避免大写或带空白的 Range 头被错误命中缓存层

### Performance

- 切歌时主线程长任务显著缩短:主题色提取从主线程同步阻塞 → Worker 异步 + transferable;`--beat-level` 写入路径从根 `:style` 触发整树(~233 节点)样式重算 → 直写到 2 个目标节点
- 节拍 RAF 循环在标签页隐藏时自动停摆,后台 CPU 占用降至 0
- `TrackList` 搜索从同步过滤 + O(n) 字符串拼接 → 防抖 + O(1) 变更标记,长曲库输入流畅度提升

## [0.1.1-rc.2] - 2026-06-17

### Changed

- 移动端禁用 Safari 双击缩放,并修复 iOS 输入框聚焦时页面自动放大的问题
- 移动端保留封面氛围光,改用椭圆裁切与径向遮罩降低 iOS Safari 方形 blur 合成瑕疵

### Fixed

- 修复 rc 构建会把 GitHub 最新正式版 `v0.1.0` 误判为可更新版本的问题

## [0.1.1-rc.1] - 2026-06-17

### Added

- 曲库全部加载失败时显示居中空态文案,并保留重新加载入口
- 断网与恢复联网时复用顶部 toast 提示当前网络状态
- 移动端曲库/设置抽屉支持全屏、半屏、关闭三段吸附与把手拖拽

### Changed

- 移动端抽屉关闭改为更接近 iOS 的手势判定:慢速下滑停到半屏,快速下甩直接关闭
- 进度条与设置滑杆扩大触摸热区,减少移动端滑动误触抽屉

### Fixed

- 修复 `Esc` 关闭移动端抽屉时缺少滑下动画的问题
- 修复移动端抽屉拖拽后切换到桌面宽度可能残留 inline transform 的问题

## [0.1.0] - 2026-06-17

首个公开版本。

### Added

- Vue 3 + TypeScript + Pinia + SCSS 技术栈,纯 Composition API 编写
- 远程歌单支持(网易云音乐、QQ 音乐,通过 Meting API)
- 本地音乐支持(置于 `public/`,在 `src/config/music.ts` 中配置)
- 歌词渲染:LRC 解析、FLIP 牵引滚动、纯音乐占位识别、用户滚动 3.2s 暂停跟随
- 节拍可视化:WebAudio FFT 双特征融合(低频能量 + 频谱通量)驱动背景呼吸与频谱条
- 封面取色:72×72 canvas 采样 + 24 桶 HSL 量化 + 综合评分,720ms cubic-out 平滑过渡
- 零延迟切歌:三 Audio 池 + 双 Preload 槽 + 650ms 交叉淡化
- PWA 支持:Service Worker(Range 请求与音视频流直通)、Manifest、可安装到桌面/移动设备
- 歌词小窗:Document Picture-in-Picture API,降级到 `window.open(popup)`
- MediaSession:锁屏控制、媒体快捷键、系统通知中心
- 睡眠定时器:0/15/30/45/60/90 分钟可选
- 键盘快捷键:`Space` 播放暂停、`←/→` 后退/快进 5 秒、`Shift+←/→` 上下曲、`L` 切换歌词、`Esc` 关闭弹层
- 响应式三态:宽屏(≥1080px)、平板(720~1079px)、移动(≤720px)
- 移动端触感反馈(5 种振动模式)、`safe-area-inset` 适配、`visualViewport` 监听
- 无障碍:`prefers-reduced-motion` / `prefers-contrast: more` 完整支持、focus trap、ARIA
- 设置持久化:`safeStorage` 包装 localStorage、版本化迁移、200ms 防抖深度 watch
- 工程兜底:所有外部 IO 8s `AbortController` 超时、`Promise.allSettled` 并行、LRU 缓存、失败曲目自动跳过
- 多平台部署配置:Vercel(`vercel.json`)、Cloudflare Pages(`wrangler.toml`)、Netlify(`netlify.toml`)、GitHub Pages(`.github/workflows/deploy-pages.yml`)
- 安全头统一:CSP、X-Content-Type-Options、X-Frame-Options、Referrer-Policy、Permissions-Policy
- CI/CD:PR 验证 workflow + main 分支自动部署 + 自动打 tag
- 代码质量保证体系:ESLint + Prettier + Husky + Commitlint + lint-staged
- 提交规范:强制 Conventional Commits 格式
- 开源协作配置:CODEOWNERS、CONTRIBUTING.md、SECURITY.md、SUPPORT.md、PR 模板、Issue 模板
- 单元测试:vitest + jsdom,40 个测试用例覆盖工具函数、解析器、缓存、服务层、PWA 安装等
- AI 协作规范文档:`agent.md`,定义代码风格、设计规范、扩展机制
- 开源协议:**GNU Affero General Public License v3.0 (AGPL-3.0-or-later)**

### Fixed

- 修复方向键 seek 行为错误:`←` / `→` 之前会被当作绝对时间(直接跳到第 0 秒 / 第 5 秒),现已正确实现"相对当前位置 ±5 秒"的语义

[0.1.1-rc.3]: https://github.com/abloom25/Meliora/releases/tag/v0.1.1-rc.3
[0.1.1-rc.2]: https://github.com/abloom25/Meliora/releases/tag/v0.1.1-rc.2
[0.1.1-rc.1]: https://github.com/abloom25/Meliora/releases/tag/v0.1.1-rc.1
[0.1.0]: https://github.com/abloom25/Meliora/releases/tag/v0.1.0
