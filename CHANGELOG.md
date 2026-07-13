# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **无密钥 CI 配置**:新增 `.github/ci-public-config.json` 与 `MELIORA_CONFIG_PATH` 构建入口,GitHub Actions 验证不再需要解密部署仓库的 `public/config.json`
- **Vercel 仓库自动识别**:未显式配置 `GH_REPO` / `GH_BRANCH` 时,自动使用 `VERCEL_GIT_REPO_OWNER`、`VERCEL_GIT_REPO_SLUG` 与 `VERCEL_GIT_COMMIT_REF`

### Changed

- **新版更新协议**:自动同步永久保留部署仓库的 `.github/workflows/` 与 `.prettierignore`,普通升级只写业务代码,不再要求 Actions 使用可修改工作流的额外 PAT;本协议不向下兼容旧更新器
- **部署数据格式检查**:恢复 `.prettierignore`,明确排除加密的 `public/admin.json`、`public/config.json` 和用户音乐目录

### Fixed

- **预发布说明缺失**:选择到 RC / prerelease Tag 后按 `/releases/tags/{tag}` 获取对应 Release,不再错误复用仅返回稳定版的 `/releases/latest`
- **更新推送被 GitHub 拒绝**:自动同步不再尝试使用内置 `GITHUB_TOKEN` 修改 `.github/workflows/`,避免 `refusing to allow a GitHub App to create or update workflow` 失败

## [0.2.0-rc7] - 2026-07-10

### Added

- **管理 API 安全链路**:新增 HMAC CSRF 请求头校验、同源写入检查、可信平台客户端 IP 传递、实例级高成本密码工作并发保护及统一安全错误响应
- **部署与资源回归测试**:新增 CSRF、限流、部署路由、音乐 API 载荷/响应上限、错误脱敏、媒体查询与管理消息定时器测试,全量测试提升至 406 项
- **播放器组件拆分**:从播放器控制区提取 `ProgressControl` 与 `TransportButtons`,补充共享媒体查询工具和管理认证卡片组件

### Changed

- **配置校验策略统一**:生产配置默认要求公网 HTTPS,仅显式开发模式允许私有地址;歌单、本地歌曲和外部测试响应增加数量与体积上限
- **管理后台结构收口**:管理 API 请求、认证卡片、限时消息、上传限制与密码规则改为共享实现,登录页可展示真实后端错误并完善表单可访问性
- **播放器状态与性能**:优化音频切换清理、预加载失败回退、歌词小窗生命周期、主题取色、封面缓存、歌曲索引和曲库交互逻辑
- **更新工作流**:临时更新分支仅保留在本地验证,全部测试通过后再合并并推送目标分支

### Fixed

- **CSRF 合法令牌被拒绝**:修复使用仅具备 `verify` 权限的 Web Crypto 密钥调用 `sign` 导致所有受保护写请求失败的问题,并移除不安全的 Cookie 令牌回退
- **播放器 ID 冲突**:拒绝重复歌单和重复本地歌曲 ID,避免队列与当前歌曲索引指向不同项目
- **错误与反馈一致性**:5xx 响应不再暴露内部异常文本;修复旧 Toast 定时器提前清除新消息以及限流/服务繁忙被误报为密码错误的问题
- **PWA 与部署路由**:动态 API、稳定上传资源及音视频 Range 请求不再被 Service Worker 错误缓存,Netlify API 重写优先于 SPA 回退

## [0.2.0-rc6] - 2026-07-05

### Added

- **404 页面兜底**:新增 `NotFoundView` 与全局 `/:pathMatch(.*)*` 路由,未知路径会展示当前缺失路径并提供「返回播放器」入口;新增 `router.test.ts` 覆盖播放器、管理后台和未知路径解析

### Changed

- **歌词切歌动画稳定性**:`LyricsPanel` 移除进度条 hover 对主歌词面板的临时驱动,改为只跟随真实播放时间;切歌加载新歌词前统一取消旧歌词请求、滚动 RAF、行级 Web Animations 和用户滚动状态,避免快速切歌时旧歌词行带着位移动画叠到封面区域
- **歌词重对齐节流**:歌词行 FLIP 滚动动画运行期间会延后相邻行的下一次重对齐请求,大跨度跳转则立即取消旧动画并切到新目标,减少快速 seek/切歌时的抖动和卡顿
- **进度条歌词预览职责收窄**:`PlayerControls` 不再通过 `onSeekPreview` 驱动主歌词面板,只保留进度条浮层预览;浮层内容切换根据指针移动方向使用 forward/backward 动画,触摸拖拽仍保持隐藏
- **移动端抽屉空间优化**:播放器曲库/设置抽屉和管理后台移动导航增加半屏偏移计算、底部延展区与 safe-area padding,提高小屏幕下拖拽、滚动和底部内容可达性;曲库、设置面板和管理导航同步加大移动端横向内边距与底部渐隐空间
- **滑杆轨道结构统一**:`SettingRange` 和播放进度条改为显式 track + fill 结构,让填充层裁切更稳定,避免圆角轨道在不同浏览器中出现视觉溢出
- **移动端预览入口调整**:便携设备上隐藏「进度条歌词预览」设置项,移动共享控制区不再启用歌词预览浮层,避免触屏拖拽时遮挡主操作区

### Fixed

- **有歌词歌曲快速切换重叠**:修复歌词已加载后快速切歌时,旧歌词动画未及时取消导致歌词短暂重叠到封面上再消失的问题
- **切歌加载态闪烁**:当前歌曲变更时若新歌存在歌词来源,歌词可用状态先进入 `loading` 而不是短暂 `unavailable`,避免歌词视图在有歌词歌曲之间切换时错误回到封面视图
- **移动抽屉关闭误伤**:播放器曲库抽屉和设置抽屉的 dismiss 回调拆分为各自关闭当前面板,避免拖拽关闭一个抽屉时顺带关闭其他面板状态

## [0.2.0-rc5] - 2026-07-04

### Added

- **进度条歌词预览**:新增 `progressLyricPreview` 播放器设置项(默认关闭),设置面板新增「进度条歌词预览」开关;桌面进度条悬停/拖拽时可在浮层中显示对应时间点的歌词原文与翻译,并通过 `LyricsPanel` 的 `previewTime` / `previewActive` 临时驱动主歌词面板预览目标行;预览采样根据指针移动速度自适应节流,触摸输入默认不显示浮层也不驱动主歌词预览,避免移动端拖拽时遮挡
- **自定义滑杆控件**:`SettingRange` 从原生 range 输入升级为自定义 `role="slider"` 控件,统一支持 pointer 拖拽、window pointerup fallback、键盘方向键/PageUp/PageDown/Home/End、`aria-valuetext` 和粗指针触控高度;`SleepTimerControl`、`EqualizerPanel`、设置面板的音量/歌词字号/背景/节奏亮度滑杆均复用该控件
- **歌词小窗加载状态**:`LyricStatus` 新增 `loading`,歌词小窗和歌词面板同步显示「正在载入歌词」状态,不再把加载中和空歌词混在一起;`useLyricsWindow` 增强 Safari/弹窗关闭检测,使用固定窗口名复用歌词小窗,并在窗口关闭、切换、卸载时清理轮询、ready 检测和事件监听
- **歌词解析增强**:`parseLyrics` 支持清除逐字歌词 `<mm:ss.xx>` 增强时间戳;`splitLyricTranslation` 支持全角中文括号;相同时间点的双行歌词会合并为原文 + 翻译,减少重复行展示

### Changed

- **播放器进度条改为自定义 slider**:`PlayerControls` 的播放进度从 `<input type="range">` 改为自定义 slider,补齐 `aria-valuemin` / `aria-valuemax` / `aria-valuenow` / `aria-valuetext`,支持键盘 seek 和全局 pointerup 提交,并保持页面版、底部 dock 进度条和移动共享控制区布局一致
- **歌词 Provider 缓存升级**:`loadTrackLyrics` 现在按 provider `cacheKey` 对曲目级歌词做 LRU 缓存并去重 in-flight 请求;共享请求保留多消费者语义,单个调用方 abort 只取消自身等待,当所有活跃调用方都 abort 时才中止底层 provider 请求,避免快速切歌时旧歌词请求无意义跑到超时
- **单曲循环播放行为**:`useAudioPlayer` 在 `playMode === 'single'` 且音频结束时直接重播当前曲目,重置 `automaticCrossfadeStarted` 和 pending seek 状态,不再走下一首预测流程
- **设置与全屏可用性**:`SettingsPanel` 仅在当前平台支持全屏且非便携设备时展示「全屏模式」开关;`useFullscreen` 补充 resize/visualViewport/fullscreenchange 状态同步,让退出全屏或浏览器 UI 尺寸变化后的状态更可靠
- **歌词面板预览和动画细节**:`LyricsPanel` 的活跃歌词时间可在预览模式下切换到进度条 hover 时间;歌词状态快照改为携带 `LyricStatus`;翻译开关、字号变化、面板激活状态和预览时间变化都会触发更精确的 snapshot 与重对齐

### Fixed

- **多指拖拽误提交**:`SettingRange` 和 `PlayerControls` 进度条现在校验当前 `pointerId`;拖拽期间来自其他手指/鼠标指针的 `pointermove`、`pointerup`、`pointercancel` 会被忽略,避免触屏场景中音量、均衡器、定时关闭或播放进度跳到错误坐标
- **自定义 slider 可访问值不一致**:`SettingRange` 的视觉进度和 `aria-valuenow` 统一使用归一化后的步进值,外部恢复出越界值或非法小数时不会出现视觉/读屏值不一致
- **歌词预览状态泄漏**:切歌、关闭 chrome、关闭歌词预览开关、取消拖拽、组件卸载时都会清理进度条歌词浮层和主歌词预览 driver,避免旧预览时间残留到下一首歌
- **播放器测试覆盖缺口**:新增 `player-controls-lyric-preview.test.ts` 与 `use-lyrics-window.test.ts`,并扩展 `settings-controls-a11y`、`track-lyrics-service`、`lyrics-panel`、`lyrics`、`use-audio-player` 等测试,覆盖歌词预览、provider 缓存、单曲循环、滑杆键盘/触摸行为和歌词小窗状态同步

## [0.2.0-rc4] - 2026-07-03

### Added

- **管理后台配置迁移页**:新增 `src/admin/views/ConfigTransferView.vue`,并在 `AdminSidebar` 中加入「迁移」导航项(`FileJson` 图标);页面提供「导出未加密配置」和「导入未加密配置」两块操作面板,导出前调用 `validateMusicConfig(props.config)` 对当前表单配置做完整 schema 校验,通过后生成 `meliora-config-plain-<ISO 时间>.json`;导出确认弹窗明确提示明文 JSON 会包含站点配置、音乐 API Token、GitHub 代理、预发布开关等敏感字段,同时说明管理员登录密码不会被反向导出;导入流程通过隐藏 `<input type="file" accept="application/json,.json">` 读取 JSON,解析失败提示「JSON 格式无效」,schema 校验失败时拼接具体错误,校验通过后先进入「覆盖当前配置?」确认弹窗,确认后仅更新后台表单并提示「确认无误后请保存」,不会直接提交到仓库
- **桌面侧边栏折叠模式**:`AdminSidebar` 新增 `desktopCollapsed` 状态与 `meliora:admin-sidebar-collapsed` localStorage 持久化键,桌面端可通过 `PanelLeftClose` / `PanelLeftOpen` 图标按钮在 200px 完整导航和 72px 图标导航间切换;折叠后隐藏品牌文案和 tab 文案,保留图标、tooltip、保存/退出/返回按钮的可访问标题;移动端强制恢复完整 sticky 顶栏布局,避免折叠状态污染手机导航
- **音乐来源适配器层**:新增 `src/services/music-adapters/types.ts` 定义 `MusicProviderAdapter<TSource>` 与 `MusicProviderContext`;新增 `local.ts` / `meting.ts` 两个 adapter,分别处理本地曲目映射和 Meting 歌单拉取;`loadConfiguredTracks` 支持通过 `LoadConfiguredTracksOptions.adapters` 注入测试/自定义 adapter,并把每个来源统一封装为 `ConfiguredSource.load(config)` 任务,后续新增其他音乐来源时不再需要把逻辑塞进 `src/services/music.ts`
- **曲目级歌词 Provider 注册表**:`src/services/lyrics.ts` 新增 `TrackLyricsProvider`、`registerTrackLyrics`、`loadTrackLyrics`、`hasTrackLyricsSource`、`hasCachedTrackLyrics`、`transferTrackLyricsProvider`、`mergeTrackLyricsProvider`;歌词来源从 `Track.lyricsUrl` 字段迁移到 WeakMap 注册表,本地曲目 provider 优先级为 20,Meting provider 优先级为 10,去重时高优先级 provider 会保留到最终曲目;`loadLrcLyrics` 统一负责 `loadLyricsText` + `parseLyrics` + 空歌词过滤
- **分享别名与标题版本兼容**:`Track` 类型新增 `titleVersions?` 和 `shareAliases?`,并将 `kind` 扩展为 `'meting' | 'remote' | 'local'`;`mapMetingTrack` / `mapLocalTrack` 通过 `splitDisplayTitle` 把标题中的版本信息拆入 `titleVersions`,`formatTrackDisplayTitle` 用于显示和分享文案;`trackIdentity` 将主标题和所有版本标题一起参与归一化,`trackMatchesShareId` 同时匹配当前哈希和历史 `shareAliases`,保证旧版基于原始标题生成的 `?share=` 链接在标题拆分后仍能定位歌曲
- **更新 workflow 防护测试**:新增 `server/tests/update-workflow.test.ts`,静态校验 `.github/workflows/update-from-upstream.yml` 必须包含 GitHub proxy 输入校验、`curl --max-redirs 0`、以及合并目标分支后重新执行 `pnpm install --frozen-lockfile`、`pnpm test`、`pnpm type-check`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`pnpm test:bundle`
- **音乐 API 重定向测试**:新增 `server/tests/music-api-tester.test.ts`,覆盖后台音乐 API 测试遇到 302 重定向时不会跟随到内网/元数据地址,并返回 `error: '重定向已拒绝'`
- **配置迁移、管理导航和播放器测试补充**:新增 `src/tests/admin-config-transfer.test.ts` 覆盖迁移入口、桌面侧边栏折叠恢复、明文配置导出风险确认、合法 JSON 导入覆盖确认、非法 JSON 校验失败;新增/扩展 `about-update-status`、`admin-about-navigation`、`dom-utils`、`settings-controls-a11y`、`track-lyrics-service`、`use-drawer-sheet`、`use-keyboard-shortcuts` 等测试,覆盖本次 UI 与数据流改动

### Changed

- **管理后台页面壳层重组**:`DashboardView.vue` 新增 `.dashboard-shell` 包裹 `AdminSidebar` 和 `dashboard-content`,桌面端保持横向布局,760px 以下改为纵向布局;tab 切换新增 `transfer` 分支,将 `ConfigTransferView` 接入主后台并复用现有 `showMessage` 通知;确认弹窗和 Toast 移入 shell 内部,确保迁移页、关于页和设置页的遮罩层级一致
- **关于页更新轮询更精细**:`AboutView.vue` 调用 `checkUpdate` 时传入 `{ markUnauthenticated: openModalOnUpdate }`,避免静默轮询状态时误把认证弹窗打断到前台;`refreshUpdateStatus` 开始读取服务端返回的 `retryAfterSeconds`,当 workflow 状态为 `locating` / `queued` / `running` 时优先使用服务端建议的轮询间隔,否则回退到 3s/5s;模板外层增加 `.about-root`,让关于页在后台 shell 中布局更稳定
- **管理后台表单可访问性补强**:`AdvancedSettingsEditor` 的预发布开关、`AnalyticsSettingsEditor` 的 Umami/Google Analytics 开关、`PlaylistEditor` 的歌单启用开关均补充明确 `aria-label`,让图标/开关控件在读屏器中不再只有泛化状态
- **播放器歌词加载链路改为按曲目加载**:`LyricsPanel.vue` 不再监听 `currentTrack.lyricsUrl`,改为监听 `[currentTrack.id, currentTrackVersion]` 并调用 `loadTrackLyrics(currentTrack)`;歌词缓存判断改为 `hasCachedTrackLyrics(track)`,空歌词/无 provider 统一进入 `empty`;`usePreloadPool` 和 `useAudioPlayer` 的歌词预加载也改为传入完整 `Track`,使本地曲目、Meting 曲目和未来 adapter 曲目的歌词来源都走同一套 provider 机制
- **当前曲目对象保活更新**:`src/stores/player.ts` 新增 `currentTrackVersion`;`setTracks` 在刷新曲库时若当前歌曲仍存在,保留原 `activeTrack` 引用并把新字段 `Object.assign` 回去,同时调用 `transferTrackLyricsProvider(track, activeTrack)` 迁移歌词 provider 并递增 `currentTrackVersion`;这样可以避免音频播放中的当前曲目对象被替换导致播放状态、歌词和预加载出现短暂脱节
- **曲目去重保留元数据**:`deduplicateTracks` 从 `Set` 改为 `Map<string, Track>`,新增 `mergeDuplicate` 回调;`loadConfiguredTracks` 在远程/本地来源去重时会合并歌词 provider 和分享别名,避免同一首歌在多个来源出现时丢失歌词来源或旧分享链接兼容信息
- **搜索和展示支持标题版本**:`filterTracks` 会同时匹配 `track.titleVersions`;`TrackList` 不再对 `track.title` 现场调用 `splitDisplayTitle`,而是直接消费 `track.title` 与 `track.titleVersions`,避免列表渲染时重复拆分标题;播放器顶部标题同样改为从 `currentTrack.titleVersions` 读取版本信息
- **分享文案统一使用展示标题**:`useTrackShare` 从 `splitDisplayTitle(track.title)` 改为 `formatTrackDisplayTitle(track)`,分享标题包含主标题和版本信息,分享 URL 继续使用 `?share=<createTrackShareId(track)>`,但打开链接时 `PlayerView` 通过 `trackMatchesShareId` 匹配当前哈希或历史别名
- **设置面板空曲库禁用**:`PlayerView.vue` 新增 `settingsAvailable = tracks.length > 0`;没有歌曲时设置按钮禁用,`aria-label` / `title` 显示「暂无歌曲,设置不可用」,如果曲库变空时设置面板已打开会自动关闭,避免空曲库下进入无意义设置抽屉
- **顶栏点击关闭面板更稳**:`PlayerView.onTopbarClick` 改用 `isInteractiveElement(e.target)` 判断交互元素,替代手写 `closest('button, a, [role="button"], input, label')`,让 label、输入框、按钮及后续扩展的交互控件不误触发关闭面板
- **开发生成流程统一**:`package.json` 新增 `generate:dev`,将 `predev`、`pretype-check`、`pretest`、`pretest:watch`、`prelint` 统一改为 `pnpm generate:dev`;`test:bundle` 显式加入脚本,本地与 CI 都能用同一命令检查构建产物泄漏
- **CI 质量门禁加严**:`main-validation.yml` 与 `pr-validation.yml` 在 `pnpm build` 后新增 `pnpm test:bundle`;`update-from-upstream.yml` 在验证阶段和合并目标分支后都加入 bundle 泄漏检查,并在最终合并前补跑 `pnpm install --frozen-lockfile`、lint、format:check,减少临时分支落后目标分支时绕过质量门禁的可能
- **GitHub proxy 输入和请求策略收紧**:`update-from-upstream.yml` 新增 `Validate GitHub proxy input` 步骤,拒绝非 http(s)、无 hostname、localhost、`.localhost`、`.local`、私有/回环/link-local/组播/reserved/unspecified IP;workflow 中经代理访问 GitHub API 的 `curl` 改为 `--max-redirs 0`,避免代理或恶意响应把请求重定向到非预期地址
- **bundle 泄漏测试显式执行时必须有 dist**:`server/tests/bundle-leakage.test.ts` 增加 `explicitBundleCheck`,只有普通全量测试且 `dist` 不存在时才 skip;当用户显式运行 `pnpm test:bundle` 时如果 `dist` 缺失会直接失败,避免误以为检查已执行

### Fixed

- **歌词请求取消误伤共享缓存**:`loadLyricsText` 调整 Abort 语义:缓存层内部 `AbortController` 只负责 8 秒超时,调用方传入的 `signal` 只取消当前等待(`withAbortSignal`),不再把外部 abort 转发到共享 fetch;修复快速切歌、预加载和面板重载同时请求同一个歌词 URL 时,一个消费者取消会把其他消费者一起取消的问题
- **更新检查拒绝 GitHub 重定向**:`server/core/update-handler.ts` 对 latest release、tags、workflow runs、workflow dispatch 请求均设置 `redirect: 'manual'`;当 GitHub 或代理返回 3xx 时,检查更新映射为 `400` 并提示「GitHub 代理重定向已拒绝,请使用直连的公网代理地址」,防止代理配置把服务端请求带到非预期目标
- **音乐 API 测试拒绝重定向**:`server/core/music-api-tester.ts` 的 `fetchWithTimeout` 增加 `redirect: 'manual'`,歌单测试遇到 3xx 时返回失败结果、保留状态码并显示「重定向已拒绝」,避免后台测试接口跟随重定向访问内网地址
- **当前曲目刷新后歌词不更新**:曲库重新加载时如果当前曲目 ID 不变但歌词 provider、标题版本或分享别名发生变化,现在通过 `currentTrackVersion` 触发 `LyricsPanel` 重新加载歌词,同时保留当前播放对象引用,修复配置更新/远程歌单刷新后歌词仍使用旧来源的问题
- **旧分享链接在标题拆分后失效**:`mapMetingTrack` / `mapLocalTrack` 会根据拆分前原始标题生成 legacy share ID,当它与新 share ID 不一致时写入 `shareAliases`;`PlayerView` 打开 `?share=` 时同时匹配别名,修复标题从「歌名 (版本)」拆为 `title + titleVersions` 后旧链接找不到歌曲的问题
- **空曲库仍可打开设置**:设置按钮在 `tracks.length === 0` 时禁用并自动关闭已打开的设置面板,避免没有任何歌曲时打开设置抽屉造成误导
- **明文配置导入/导出类型构建问题**:`admin-config-transfer.test.ts` 改为显式保存导出的 Blob holder,并使用 `find(...).exists()` 做 Vue Test Utils 断言,修复 `vue-tsc -b` 在项目引用构建下对可选链和 `get().exists()` 的类型误判
- **音乐 adapter 联合泛型构建问题**:`src/services/music.ts` 将 `ConfiguredMusicSource<T>` 联合改为闭包式 `ConfiguredSource.load(config)`,消除 `ConfiguredMusicSource<LocalTrackConfig>` 被错误传给 `ConfiguredMusicSource<MetingPlaylistConfig>` 的 TypeScript 构建错误

## [0.2.0-rc3] - 2026-07-01

### Added

- **歌词翻译开关**:新增 `lyricTranslation` 设置项(默认开启),关闭时翻译行通过 `<Transition name="translation-toggle">` 以 `max-height: 2.2em → 0` + `translate: 0 → -0.18em` + `opacity: 0.76 → 0` 三重过渡动画收起;`PlayerSettings` 类型与 `migrateSettings` 均新增该字段,默认值 `true` 保证向后兼容;`displayedLines` computed 在关闭时逐行剥离 `translation` 字段,同时 `emitSnapshot` 改发 `displayedLines` 而非原始 `lines`,歌词小窗同步响应翻译开关
- **管理后台移动端导航面板**:`AdminSidebar` < 760px 时折叠为 sticky 顶栏(站点名 + 面包屑 + 汉堡按钮),新增 `<Teleport to="body">` 底部抽屉式 `mobile-nav-panel`,复用 `useDrawerSheet` 实现全屏/半屏/关闭三段吸附拖拽,`isMobileViewport()` 动态启用;面板内双列 `grid` 布局容纳 7 个导航标签,底部 `sidebar-footer` 包含「保存全部」(跨列占满)、「退出登录」、「返回播放器」三按钮;关闭时选中标签/保存/退出均自动触发 `dismissMobileNavAnimated()`,遮挡层 `.mobile-nav-backdrop` 半屏时扩大 inset 覆盖全屏并加深背景;面板样式统一玻璃拟态(`backdrop-filter: blur(52px) saturate(180%)`)+ 圆角顶部 + 底部 safe-area-inset 适配,420px 以下进一步紧凑间距
- **`useFocusTrap` `autoFocus` 选项**:新增可选的 `options.autoFocus` 参数,类型为 `MaybeRefOrGetter<boolean>`,默认 `true`;当 `toValue(options?.autoFocus) === false` 时跳过自动聚焦但仍设置 `pendingActivation = false` 避免状态卡死,移动端 sheet 抽屉(`libraryDrawerRef`)传入 `autoFocus: () => !isMobileSheet.value` 以跳过移动端自动对焦
- **`PlayerControls` 竖排布局 `variant="vertical"`**:新增长 54px 的纵向排列模式,播放/上一首/下一首按钮按列堆叠(`flex-direction: column`),播放按钮 46×46px 带 `box-shadow` 强调,不渲染进度条行(`variant !== 'bar' && variant !== 'vertical'`),用于歌词小窗等窄空间场景
- **开发模式本地配置同步**:`vite.config.ts` 新增 `melioraLocalConfigPlugin`,在 Vite dev server 注册 `POST /__meliora-dev/config` 中间件;管理后台 `saveConfig` 在 `import.meta.env.DEV` 下自动将清洗后的配置 `POST` 到该端点,插件经 `validateMusicConfig` 校验后写入 `.meliora/config.local.json` 并调用 `generatePublicConfig` 重新生成 `src/generated/public-config.ts`,最后通过 `server.ws.send('full-reload')` 触发热更新,开发环境改配置后无需手动重启;`SaveResult` 新增 `warning?` 字段,同步失败时 `ok: true` 但携带 warning 提示
- **本地开发配置优先读取**:`generatePublicConfig` 在 `MELIORA_LOAD_DEV_VARS=true` 且 `.meliora/config.local.json` 存在时,优先以它作为配置源生成本地公开配置,代替 `public/config.json`;`pnpm generate:public-config:dev` 复用此逻辑
- **`createTrackShareId` 确定性分享标识**:`src/utils/tracks.ts` 新增基于 FNV-1a 哈希(`hashShareIdentity`)的确定性 share ID,输入为 `trackIdentity`(标题+艺术家归一化),输出为 36 进制短字符串(不含内部 URL 敏感信息);分享 URL 从 `?track=<track.id>` 改为 `?share=<hash>`,`useTrackShare` 分享文案从「正在 Meliora 收听」改为「Meliora: <标题 - 艺术家>」,剪贴板内容同步简化;`loadTracks` 改为按 `share` 参数匹配加载后自动移除参数避免分享链接残留
- **`shouldUseIOSBackgroundSafeAudio` 浏览器能力检测**:`src/utils/browser.ts` 新增该函数,返回 `isIOSDevice() && isSafariBrowser()` 的合取,统一标识 iOS Safari 后台播放受限场景
- **`useDeviceDetection` composable**:新增 `src/composables/useDeviceDetection.ts`,抽离原本散布在 `App.vue` 中的 `compactViewport`、`portableDevice`、`phoneDevice`、`lyricsWindowSupported` 和 `isMobileSheet`、`viewportMode`(枚举 `wide/narrow/phone`)等设备检测逻辑为独立 composable

### Changed

- **播放器架构拆分**:原 2500 行 `App.vue` 拆为两文件——`App.vue` 缩至 ~25 行,仅保留 `<router-view>` + `<Transition mode="out-in">` 作为路由壳(接管原 `AppShell.vue` 职责);播放器全部业务逻辑迁移至 `src/views/PlayerView.vue`;路由从 `component: App` 改为 `component: PlayerView`;`main.ts` 直接挂载 `App` 而非 `AppShell`;`AppShell.vue` 已删除;`agent.md` 分层图同步更新为 `src/main.ts → src/App.vue → src/views/PlayerView.vue`
- **`SettingsPanel` 去 props 化**:组件不再通过 props 接收 `settings: PlayerSettings`,改为内部直接 `storeToRefs(usePlayerStore())` 获取响应式 `settings`;`PlayerView.vue` 移除 `:settings="settings"` 传递;消除了 15 处 `vue/no-mutating-props` ESLint 违规;`PlayerSettings` 类型导入从 SettingsPanel 移除,不再依赖 `src/types/music`
- **`LyricsPanel` 滚动对齐全面重构**:
  - 新增 `syncActiveLyric({ realign?, animate? })` 统一入口:计算当前活跃行索引 → 写入 `targetIndex`/`activeIndex` → 变更时 `emitSnapshot` → 默认触发 `scheduleRealign`
  - 新增 `scheduleRealign({ animate? })`:通过 `realignRequestId` 版本号 + `nextTick` + `requestAnimationFrame` 双重异步守卫防止竞态,在 `active`/非 `userScrolling`/有效 `targetIndex` 前提下执行 `scrollToIndex`
  - `scrollToIndex` 新增 `ScrollToIndexOptions` 参数:支持 `options.animate` 强制跳过动画;非动画模式下调用 `markProgrammaticScroll()` 标记程序化滚动防止误触发用户浏览模式
  - 拆分滚动事件处理:`handleScrollIntent`(wheel/touchmove)→ 重置 restore timer;`handleScroll`(scroll 事件本身)→ 仅在非程序化滚动时标记用户浏览但不重置 timer;`isProgrammaticScroll` 通过 180ms timeout 自动复位
  - 新增 `handleKeydown`:检测 `ArrowDown/ArrowUp/End/Home/PageDown/PageUp/Space` → 调用 `handleScrollIntent`,防止键盘导航触发用户浏览模式后自动回滚
  - `handleViewportResize`:监听 `window.resize` 与 `visualViewport.resize`,触发无动画重对齐
  - 新增 `ResizeObserver` 观察 `panel`/`scroller`/`lyricsContent` 三个节点,尺寸变化时自动 `scheduleRealign`;`lyricsContent` ref 变更时重新绑定 observer
  - 歌词行间距从固定 `clamp(18px, 2.5vh, 28px)` 改为动态 `clamp(22px, calc(var(--lyric-size) * 1.28), 42px)`,随 `--lyric-size`(歌词字号)自适应
  - `--line-distance` CSS 变量从每个 `<button>` 的 inline style 改为 `.distance-0` ~ `.distance-5` 六个 CSS class,减少每个歌词行的运行时 style 计算
  - `--lyric-size` CSS 变量从逐个 `.lyric-line` 上移至 `.lyrics-panel` 根节点
  - 浏览模式 hover 行新增 `::before` 伪元素半透明高亮背景效果
  - `onMounted` / `onBeforeUnmount` 生命周期增强:挂载时注册 resize/visualViewport 监听 + 初始化 ResizeObserver + 首次 `scheduleRealign`;卸载时清理 `realignRaf`/`programmaticScrollTimer`/`resizeObserver.disconnect()`/两个 resize 事件监听
  - 新增 `active` prop(默认 `true`):当从 mobile `cover` tab 切回 `lyrics` tab 时立即 `syncActiveLyric({ animate: false })` 无动画对齐
  - `lyricFontSize`/`lyricAnimation`/`lyricTranslation`/`active` 四个 watcher 各自监听并触发合适的重对齐策略
- **翻译切换动画**:翻译行包裹 `<Transition name="translation-toggle">`,CSS 定义 `max-height`(2.2em ↔ 0)、`margin-top`、`opacity`(0.76 ↔ 0)、`translate`(0 ↔ -0.18em) 四属性 360ms cubic-out 过渡;`lyrics-panel.animation-disabled` 和 `prefers-reduced-motion` 下过渡时长清零
- **iOS Safari 后台播放适配**:`useAudioPlayer` 检测到 `shouldUseIOSBackgroundSafeAudio()` 时执行以下适配:(a)所有 `<audio>` 创建时强制设置 `playsInline` + `playsinline` + `webkit-playsinline` 属性;(b)新增 `ensureIOSAudioHost()` + `mountActiveAudioForIOS()`——在 `<body>` 中创建隐藏的 1×1px `div` 容器并将活跃 `<audio>` 节点挂载为 DOM 子节点,使 iOS Safari 在后台/锁屏时维持 Media Session 播放;(c)`guardedStartBeatAnalysis` 完全跳过——无 Web Audio 分析链路;(d)切歌关闭 `smoothTrackChange` crossfade(后台淡入淡出不可靠);(e)自动 crossfade(歌曲末尾预切换)也关闭;(f)初始化、切歌、错误恢复三条路径均调用 `mountActiveAudioForIOS()`;(g)卸载时 `iosAudioHost?.remove()` 清理
- **`useBeatAnalyser` 音频资源释放**:`stopBeatAnalysis` 在断开 analyser 节点后,若共享 `AudioContext.state === 'running'` 则调用 `suspend()` 挂起(不 `close()`),释放音频硬件;后续 `startBeatAnalysis` 可通过 `resume()` 恢复
- **分享链接去内部 ID 化**:`useTrackShare.shareCurrentTrack` 改用 `createTrackShareId(track)` 生成 FNV-1a 哈希作为分享参数,URL 构造从 `new URL(window.location.href)` + `.hash = ''` 改为 `new URL(window.location.pathname, window.location.origin)` 彻底去 query/hash;分享文案「正在 Meliora 收听 X」→「Meliora: X」;剪贴板文本同步更新
- **`TrackList` 搜索输入简化**:`debouncedQuery` 从 `:value` + `@input` 手动绑定改为直接 `v-model="debouncedQuery"`,新增 `watch(debouncedQuery, (v) => handleSearchInput(v))` 替代原来的 `watch(() => props.query)` 中介;`handleSearchInput` 移除对内 `debouncedQuery.value = value` 赋值(已被 v-model 覆盖),减少一层数据流迂回
- **管理后台全页面移动端响应式增强**:
  - `AdminApp.vue`:<760px 时 `admin-body` 从横向 flex 改为纵向 column 并 `overflow: hidden`,等待状态 `.admin-notice` 限制最大宽度并紧凑 padding
  - `DashboardView.vue`:移动端 `.dashboard-content` 补加底部 `calc(86px + env(safe-area-inset-bottom))` padding 避免被底部未保存指示器遮挡,section 间距和字号适配,`.unsaved-indicator` 改为全宽居中
  - `SiteSettingsEditor.vue`/`SecurityEditor.vue`/`AdvancedSettingsEditor.vue`/`AnalyticsSettingsEditor.vue`:720px 以下各 editor 统一收紧间距、`flex-direction: column` 垂直布局、`border-radius: 16px`、section title 字号降至 0.58rem;SiteSettings 的 token 输入框和图标上传在 420px 以下全宽并对齐
- **`useDrawerSheet` 事件去重**:`handlePointerMove` 增加判断:若拖拽由 handle 发起(`state.source === 'handle'`)且 `e.currentTarget === attachedContainer` 则直接 return,防止同一个 pointermove 在 handle 和 container 上各触发一次导致跳动
- **`useLyricsWindow` 歌词小窗跨 toggle 复用**:`openViaWindowOpen` 的 `window.open` 使用固定窗口名称 `'meliora-lyrics'`,跨 toggle 操作时浏览器将聚焦/复用同一小窗而非每次新建;`teardownWindow` 在关闭/切歌前清理 `cachedNodes` 与事件监听,`render()` 开头通过 `isWindowClosed` 守卫防止操作已销毁窗口
- **版本脚本路径参数化**:`generatePublicConfig` 将三个关键路径(`configPath`/`targetPath`/`adminEnvTargetPath`)从模块级常量改为 `resolve*()` 函数,并在 DEV 模式下支持 `.meliora/config.local.json` 作为优先配置源;`fileExists` 辅助函数用 `fs.access` 替代 try/catch readFile
- **测试增强**:
  - `use-audio-player.test.ts`:mock `shouldUseIOSBackgroundSafeAudio` 和 `useBeatAnalyser`;新增 3 个 iOS 适配测试(验证 `playsinline` 属性/DOM 挂载、跳过 Web Audio 分析、关闭自动 crossfade);`afterEach` 增加 `document.body.innerHTML = ''` 清理 DOM
  - `tracks.test.ts`:新增 `createTrackShareId` 两个测试(输出不含敏感 URL/纯小写字母数字/长度 <16、share ID ≠ track.id)
  - `player-store.test.ts`:迁移测试确认 `lyricTranslation` 默认值和非法值 sanitize 行为
  - `use-preload-pool.test.ts`:默认 settings 补上 `lyricTranslation: true`
  - `server/tests/generate-public-config.test.ts`:新增「本地开发优先读取 `.meliora/config.local.json`」测试
- **README 补充**:
  - 新增「本地配置同步」章节:说明 `DEVELOPMENT=true` 时配置同步流程、`.meliora/` 目录用途、`generate:public-config:dev` 的优先读取逻辑、真实生产链路测试指引
  - header 导航新增「路线图」链接指向 `ROADMAP.md`
  - 尾部署名补上 `and OpenAI Codex`
- **`agent.md` 规范更新**:分层图路径、依赖方向注释、路由过渡参考文件等随架构拆分同步修正;新增 `views/` 层描述

### Fixed

- **`useFocusTrap` 未使用变量**:移除声明后从未引用的局部 `autoFocus` 变量(实际代码直接调用 `toValue(options?.autoFocus)`),消除对应的 `@typescript-eslint/no-unused-vars` ESLint 错误
- **`PlayerView.vue` 未使用导入**:移除 `PlayerViewportMode` 类型导入与 `viewportMode` 解构变量(设备检测逻辑已迁至 `useDeviceDetection` 后不再被引用)
- **`SettingsPanel.vue` 15 处 props 直接修改**:组件改为使用 Pinia store 后彻底消除 `vue/no-mutating-props` 违规
- **5 处 Prettier 格式化违规**:`useFocusTrap.ts` import 语句、`PlayerView.vue` 缩进/解构/多行属性、`TrackList.vue` v-model 换行均由 `eslint --fix` 自动修复

[0.2.0-rc7]: https://github.com/abloom25/Meliora/releases/tag/v0.2.0-rc7
[0.2.0-rc6]: https://github.com/abloom25/Meliora/releases/tag/v0.2.0-rc6
[0.2.0-rc5]: https://github.com/abloom25/Meliora/releases/tag/v0.2.0-rc5
[0.2.0-rc4]: https://github.com/abloom25/Meliora/releases/tag/v0.2.0-rc4
[0.2.0-rc3]: https://github.com/abloom25/Meliora/releases/tag/v0.2.0-rc3

## [0.2.0-rc2] - 2026-06-30

### Added

- **播放器均衡器组件**:新增 `EqualizerPanel`,承载均衡器开关、预设选择、自定义频段增益调节,预设切换时触发触感反馈
- **定时关闭组件**:新增 `SleepTimerControl`,将定时关闭滑块、刻度、剩余时间展示从主 `App.vue` 中拆出
- **触感反馈 composable**:新增 `useHaptic`,统一封装 `light`、`medium`、`heavy`、`selection`、`success`、`warning`、`error` 等振动模式,并在非手机设备或 `prefers-reduced-motion` 下自动禁用
- **播放队列预测 API**:播放器 store 新增 `peekNext()` / `peekPrevious()`,可在不改变当前曲目、进度和队列版本的情况下预测上一首/下一首
- **跨域音频降级播放**:`useAudioPlayer` 新增 Web Audio CORS 失败降级路径,分析链路无法接入时会重建无 `crossOrigin` 的 audio 元素,保留播放能力并降级节拍分析
- **主封面 CORS 回退**:主封面以 `crossorigin="anonymous"` 首次加载失败时会移除 `crossorigin` 重建图片,优先保证封面显示,取色失败则回退默认主题
- **共享配置 schema**:新增 `shared/config-schema.ts`,服务端保存配置和构建期公开配置生成共用同一套字段清洗与校验;覆盖 `receivePrereleaseUpdates`、`githubProxy`、统计、站点验证、自定义 CSS/JS 等字段
- **共享环境 schema**:新增 `shared/env-schema.ts`,统一 `DEVELOPMENT` 真值解析、`GH_REPO` 格式校验与 `CONFIG_ENCRYPTION_KEY` 强度校验
- **共享版本工具**:新增 `shared/version.ts`,支持严格 SemVer 解析、比较、预发布判断、`v` 前缀 / `refs/tags/` 规范化和最新版本选择
- **构建期公开配置生成**:新增 `scripts/generate-public-config.mjs` 与 `scripts/generate-public-config.d.mts`,从缺失、明文或加密的 `public/config.json` 生成 `src/generated/public-config.ts` 与 `src/generated/admin-env.ts`
- **管理后台构建状态**:公开配置生成时同步输出 `idle`、`disabled`、`env-not-ready` 状态,前端可展示管理后台禁用或环境变量未就绪原因
- **Pages 本地开发准备脚本**:新增 `scripts/prepare-pages-dev.mjs`,为 Wrangler Pages Functions 本地开发创建 `.wrangler/pages-dev-static`,让 Vite 提供页面、Wrangler 只模拟 `/api/*`
- **Cloudflare Pages 静态规则**:新增 `public/_headers` 与 `public/_redirects`,统一安全响应头、Service Worker 缓存、manifest 类型、静态资源 immutable 缓存与 SPA fallback
- **一键更新状态跟踪**:后台触发更新后返回 `triggeredAt` 与 `triggerId`,关于页持续轮询 GitHub Actions 状态并展示日志链接、失败详情和成功提交链接
- **更新状态接口**:新增 `GET /api/update/status?since=...&triggerId=...`,归一化返回 `locating`、`queued`、`running`、`success`、`failed`、`cancelled`、`timed_out`,并带 `retryAfterSeconds`、Actions URL、commit URL 与失败消息
- **预发布版本开关**:高级设置新增“接收预发布版本”,稳定版默认只接收稳定更新;开启后可接收 rc / beta / alpha,当前版本本身为 prerelease 时继续自动接收 prerelease
- **主分支验证 workflow**:新增 `.github/workflows/main-validation.yml`,在 `main` push 与手动触发时执行安装、测试、类型检查、Lint、格式检查、构建、自动 tag;稳定版自动创建 GitHub Release,预发布版仅打 tag
- **管理后台上传常量**:管理 API 新增 `MAX_UPLOAD_BYTES`、`MAX_UPLOAD_BASE64_LENGTH`、`MAX_UPLOAD_SIZE_LABEL`,统一前端上传限制
- **本地曲目编辑提示**:本地曲目编辑器新增未补全提示,缺少 ID、标题、艺术家或音频时提示保存会被拦截
- **本地曲目删除失败展示**:删除确认框新增逐项失败展示,便于看到具体失败文件

### Changed

- **版本升级**:`package.json` 版本从 `0.2.0-rc1` 升级到 `0.2.0-rc2`
- **运行环境收紧**:`package.json` engines 从 Node `>=20` / pnpm `>=8` 调整为 Node `>=22` / pnpm `>=11.5.3`,并固定 `packageManager` 为 `pnpm@11.5.3`
- **生成流程拆分**:`generate` 拆为 `generate:app-version` 与 `generate:public-config`;`predev` 使用开发变量生成公开配置,`prebuild`、`pretest`、`pretype-check`、`prelint` 统一先生成构建产物
- **前端配置加载改为构建期公开配置**:播放器从异步 `/api/runtime-config` 改为同步读取 `loadMusicConfig()`,并按公开 `apiEndpoint` 注入 `preconnect`
- **类型拆分公开配置和完整配置**:新增 `PublicMusicConfig`,前端公开配置不再包含 `apiToken`、`githubProxy`、`receivePrereleaseUpdates` 等管理员/服务端字段
- **Meting 请求去 token 化**:前端歌单请求不再向 Meting API URL 拼接 `token`,只发送 `server`、`type`、`id`
- **播放器主文件瘦身**:`App.vue` 移除内联均衡器、定时关闭、触感反馈逻辑,改为组合 `EqualizerPanel`、`SleepTimerControl`、`useHaptic`
- **空曲库体验调整**:无曲目时提示改为“暂无可播放歌曲,请在管理后台添加音乐”,且不再把空曲库视为加载失败
- **切歌状态机重构**:`useAudioPlayer` 改为明确的 `idle/switching` 状态机,使用 `AbortController` 取消过期切歌请求
- **音量淡入淡出重构**:fade 动画从全局计数改为按 audio 元素独立管理,避免新旧音频淡入淡出互相取消
- **预加载目标预测统一**:预加载池复用 store 的 `peekNext()` / `peekPrevious()`,保证顺序、循环、单曲、随机模式下预加载目标与实际切歌一致
- **预加载失败文案调整**:后台预加载失败提示改为“预加载歌曲暂时无法播放,当前播放不受影响”,避免误报“已跳过”
- **虚拟曲库列表布局调整**:`TrackList` 使用完整高度 spacer 包裹绝对定位条目,空列表时不渲染大高度 spacer
- **封面缓存上限**:`useCoverCache` 对 loaded / failed 封面缓存增加 512 条上限,按最近使用淘汰旧 trackId
- **Reduced motion 行为调整**:`useBeatAnalyser` 在 reduced motion 下仍构建 Web Audio / EQ 图,但跳过视觉 RAF 循环和可见性监听
- **Media Session 清理**:无当前曲目时清空 metadata 并设置 playbackState 为 `none`
- **开发模式显式化**:服务端从“根据 `GH_TOKEN` 是否为空/占位符推断本地模式”改为显式 `DEVELOPMENT=true/1/yes/on`;Vercel、Cloudflare Pages、Netlify API 入口均透传 `DEVELOPMENT`
- **环境就绪校验调整**:生产环境重点校验 `GH_REPO` 格式与 `CONFIG_ENCRYPTION_KEY` 强度;`GH_TOKEN` 不再作为公开状态页硬性校验项,需要写 GitHub 的接口仍会单独检查 token
- **配置读取 fail-closed**:`getConfig` 在 GitHub 读取失败时返回 `502`;生产明文配置返回 `409`;解密失败返回 `409` 并提示检查 `CONFIG_ENCRYPTION_KEY`;保存时写入 shared schema 清洗后的配置
- **状态页改为 JSON 状态**:`renderEnvNotReadyPage` 与 `renderDisabledPage` 不再返回完整 HTML,状态探针返回 `{ status, detail }`,由前端渲染管理后台禁用/环境未就绪状态
- **更新检查改为 POST JSON**:`/api/check-update` 从 GET query 改为带认证、同源校验、JSON Content-Type 的 POST body,携带 `current`、`githubProxy`、`receivePrereleaseUpdates`
- **更新检查逻辑增强**:同时读取 latest release 和 tags;release 不可用时 fallback 到 tag;Tags fallback 使用 `per_page=100`;版本选择改用严格 SemVer 排序
- **预发布策略明确**:稳定版默认忽略 prerelease;当前版本为 prerelease 或显式开启“接收预发布版本”时才接收 prerelease
- **GitHub 请求错误映射**:更新检查统一 8 秒超时,并将 401/403/429/5xx/超时映射为可操作错误
- **GitHub 代理语义收敛**:检查更新可走代理且不附带 `GH_TOKEN`;workflow dispatch 与 Actions 状态查询始终直连 GitHub API,代理仅作为 workflow input 传给上游拉取步骤
- **更新目标精确锁定**:检查更新返回 `targetTag`,触发 workflow 时传入 `target_tag`、`allow_prerelease`、`trigger_id`,workflow 优先同步后台选定 tag
- **更新轮询限流调整**:`/api/update/status` 调整为 240 次 / 15 分钟,覆盖最长 10 分钟 running 轮询窗口
- **上传路径白名单收紧**:`/api/upload` 从允许整个 `public/` 改为只允许 `public/music/` 下白名单媒体/歌词/图片扩展名,以及 `public/icon.png|jpg|jpeg|webp|ico`
- **上传大小统一**:本地曲目和站点图标上传限制统一为 25MiB,base64 长度限制精确匹配 25MiB 文件边界
- **删除文件返回结构化**:删除 API 从简单布尔返回改为 `DeleteFilesResult`,前端校验返回数量并展示逐项失败;远端文件不存在时视为已删除成功
- **GitHub Contents API 编码增强**:仓库、分支和文件路径按段编码,避免 `?/#/&/空格` 等字符扭曲 URL 或注入查询参数
- **认证与密码安全增强**:管理员密码 PBKDF2 迭代次数从 100k 提升到 600k;`tokenVersion` 缓存 TTL 从 30 秒缩短到 5 秒;开发模式 Cookie 签名密钥包含 `GH_REPO`;限流键移除可伪造的 User-Agent
- **API 写请求同源校验**:所有 `/api/` 下 POST/PUT/DELETE 检查 `Origin` 或 `Referer`;跨站返回 `403`;开发模式允许 localhost Vite/Wrangler 代理写请求
- **本地后端开发命令调整**:`dev:admin` 先执行 `prepare-pages-dev.mjs`,再运行 `.wrangler/pages-dev-static`,不再依赖旧 `dist`
- **格式化命令兼容性**:`format` 与 `format:check` 增加 `--ignore-unknown`
- **Vite base 固定**:`vite.config.ts` 的 `base` 从 `process.env.BASE_PATH || '/'` 改为固定 `/`
- **部署平台收敛**:移除 GitHub Pages 部署假设,平台口径收敛为 Vercel、Netlify、Cloudflare Pages
- **Cloudflare Pages 配置瘦身**:`wrangler.toml` 只保留核心 Pages 配置,headers/redirects 迁移到 `public/_headers` / `public/_redirects`
- **Netlify 构建环境固定**:`PNPM_VERSION` 从 `11` 固定为 `11.5.3`,并移除重复 inline build environment
- **TypeScript 覆盖范围扩展**:`tsconfig.app.json` 与 `tsconfig.server.json` 纳入 `shared/**/*.ts`;服务端 tsconfig 增加 Node types
- **版本脚本 fail-fast**:`generate-app-version.mjs` 与 `inject-sw-cache-name.mjs` 校验 `package.json` version 必须是合法 SemVer,不再静默回退 `0.0.0`,并用 `JSON.stringify` 输出版本字符串
- **Service Worker cache 注入 fail-fast**:`inject-sw-cache-name.mjs` 在 `dist/sw.js` 缺少 `__SW_CACHE_NAME__` 占位符时直接失败
- **用户数据保留规则调整**:上游同步继续保留 `.dev.vars`、`.env`、`.env.local`、`.env.production`、`public/admin.json`、`public/config.json`、`public/music/`、构建产物和本地目录;模板文件可随上游更新
- **站点图标上传流程调整**:上传成功等待 FileReader 和网络请求均完成后再提示,默认使用 `png` 后缀,上传类型移除 SVG
- **管理员密码前端限制增强**:修改密码最小长度从 6 位提升到 8 位

### Fixed

- **快速切歌竞态**:修复旧切歌请求继续提交状态、旧音频叠放播放、切歌异常后长期卡在过渡状态的问题
- **旧音频静音失败**:修复手动切歌时旧音频淡出被新音频淡入取消,导致旧音频未及时静音的问题
- **曲库刷新同步**:修复当前曲目从刷新结果中被删除后仍保留旧曲目、进度、时长或播放状态的问题;队列现在会同步删除不存在歌曲并追加新增歌曲
- **pending seek 回弹**:修复无 metadata 时 seek 导致进度条回弹的问题,现在先记录 pending seek 并更新 UI,待 duration 可用后再写入 audio
- **播放失败反馈**:修复 `skipOnError` 关闭或队列只有一首时错误消息被清空的问题
- **卸载后自动跳过**:修复自动跳过计时器在组件卸载后仍可能触发的问题
- **跨域音频播放**:修复跨域音频无法接入 Web Audio API 时播放被节拍分析拖垮的问题,现在降级分析但继续播放
- **跨域封面显示**:修复跨域封面缺少 CORS 响应头时直接失败、不显示封面的问题
- **歌词缓存 abort**:修复歌词缓存命中时调用方 abort signal 无法独立生效、已 abort signal 没有立即 reject 的问题
- **持久化设置清洗**:修复 `NaN`、`Infinity`、越界数值、非法播放模式、非法均衡器预设等脏数据泄漏到运行时的问题
- **虚拟列表高度**:修复曲库虚拟列表滚动高度不完整、空状态前出现异常大 spacer 的问题
- **Media Session 兼容**:修复 Safari/旧浏览器 Media Session 赋值或 handler 注册失败时可能影响播放流程的问题
- **管理后台状态识别**:修复管理后台禁用或环境未就绪时可能被误判为“后端不可用”的问题
- **状态页 HTML 写入**:修复 `/api/setup-status` 返回 HTML 时前端直接 `document.write()` 替换页面的问题,改为标记 API 不可用
- **登录过期处理**:修复配置加载、保存、上传、删除、改密、音乐 API 测试、更新检查/触发/状态查询遇到 401/403 后本地仍保持已登录状态的问题
- **配置提交前校验**:修复无效本地曲目配置可能被提交到后端的问题
- **本地文件部分删除**:修复本地曲目文件部分删除失败时仍从配置中移除曲目的问题
- **删除结果校验**:修复删除文件接口未校验后端返回结果数量或逐项失败状态的问题
- **站点图标上传竞态**:修复文件读取/上传尚未完成时就进入成功状态的问题
- **更新检查回写竞态**:修复重复检查和组件卸载后异步状态回写的风险
- **更新触发反馈**:修复触发更新后只能显示短暂提示、无法跟踪 GitHub Actions 执行结果的问题
- **后端错误 detail 展示**:修复更新检查或触发失败时未优先展示后端 `detail` 的问题
- **超大上传拦截**:修复超大 base64 上传内容仍可能被发送到后端的问题
- **密钥耦合**:修复 `GH_TOKEN` 轮换会影响配置解密/签名的问题,配置加密和 Cookie 签名均改用 `CONFIG_ENCRYPTION_KEY` 派生
- **配置读取静默回落**:修复生产配置读取失败、明文配置或解密失败时静默回落默认配置的问题,避免隐藏密钥错误或配置损坏
- **初始化重开风险**:修复 `admin.json` 明文或解密失败可能被误判为未初始化并重新开放 setup 的风险
- **代理 SSRF**:修复 `githubProxy` 可指向内网/本地地址的风险,同时避免通过代理检查更新时泄露 `GH_TOKEN`
- **跨站写请求**:修复旧版 CORS/OPTIONS 行为与 Cookie 凭据组合可能形成跨站管理 API 风险的问题
- **更新接口非 JSON 触发**:修复 `/api/update`、`/api/check-update` 可接受非 JSON 请求并触发外部调用的问题
- **上传覆盖敏感文件**:修复上传接口可覆盖 `public/sw.js`、manifest、robots、`public/config.json`、`public/admin.json` 或上传可执行前端资源的风险
- **上传路径绕过**:修复路径穿越、URL-like path、编码穿越、畸形 percent encoding 等路径校验绕过
- **GitHub 路径编码**:修复 GitHub 文件路径未编码导致特殊字符影响 Contents API URL 的问题
- **更新版本比较**:修复预发布、tag fallback、非法 tag、字符串排序导致的更新误判
- **删除远端 404**:修复删除远端已不存在的允许路径时被标记为删除失败的问题
- **PWA API 缓存**:修复 Service Worker 缓存优先策略可能让 `/api/auth` 返回旧登录状态的问题,现在 `/api/*` 直接放行网络
- **PWA 缓存清理范围**:修复 activate 阶段清理过宽的问题,现在只清理 `meliora-shell-` 前缀且非当前版本的缓存
- **更新 workflow 直写目标分支**:修复上游同步后直接 push 目标分支的风险,现在先推临时分支、完成验证、合并目标分支最新状态并再次验证后才写回
- **Cloudflare Pages 规则兼容**:修复 headers/redirects 放在 `wrangler.toml` 的兼容性问题,迁移到 `_headers` / `_redirects`

### Removed

- **移除前台更新检查服务**:删除未接线的 `src/services/updates.ts` 与 `src/tests/updates-cache.test.ts`,更新入口统一收敛到后台关于页
- **移除 `/api/runtime-config`**:公开运行配置改由构建期 public config 提供;就绪、禁用、环境未就绪状态下均返回 404
- **移除服务端内置 HTML 状态页模板**:状态页接口只返回 JSON 状态
- **移除旧配置校验导出**:删除 `server/core/config-handler.ts` 内部 `validateConfig`,配置校验迁移到 `shared/config-schema.ts`
- **移除 `GH_TOKEN` 占位符本地模式推断**:开发模式必须显式配置 `DEVELOPMENT`
- **移除前端运行时配置拉取路径**:播放器不再请求 `/api/runtime-config`
- **移除前端 Meting token 拼接**:前端不再把 `apiToken` 拼进歌单请求 URL
- **移除 `App.vue` 内联均衡器 / 定时关闭 / 触感反馈逻辑**:对应逻辑改由新组件和 composable 接管
- **移除抽屉 opener `defineExpose` 引用**
- **移除 GitHub Pages 部署 workflow**:删除 `.github/workflows/deploy-pages.yml`,部署平台收敛为 Vercel、Netlify、Cloudflare Pages
- **移除 GitHub Pages 文档口径和相对 base 假设**:README / SUPPORT 不再宣称支持 GitHub Pages 自动部署,`vite.config.ts` 不再读取 `BASE_PATH`
- **移除内置 DEVOTION 示例资源**:删除 `public/music/DEVOTION/audio.flac`、`cover.jpg`、`lyrics.lrc`
- **移除 SVG 站点图标上传支持**:保留 PNG、JPEG、WebP、ICO

### Tests

- **播放器测试**:新增 `use-audio-player.test.ts`,覆盖公开 API、选曲播放、快速连续下一首、暂停、pending seek、播放失败自动跳过、卸载清理计时器、当前曲目被移除后的状态清空
- **播放器 store 测试**:扩展 `player-store.test.ts`,覆盖曲库刷新同步队列、删除当前曲目、`peekNext()` / `peekPrevious()` 在循环/顺序/单曲/随机模式下的行为、纯预测不变更状态、非法持久化设置 sanitize
- **预加载测试**:新增 `use-preload-pool.test.ts`,验证预加载预测与 store 预测一致,并覆盖预加载失败提示不误报跳过
- **曲库列表测试**:新增 `track-list.test.ts`,覆盖虚拟列表完整滚动高度和空状态不渲染 spacer
- **封面缓存测试**:新增 `use-cover-cache.test.ts`,覆盖 loaded / failed 缓存 512 条上限与旧项淘汰
- **节拍分析测试**:新增 `use-beat-analyser.test.ts`,覆盖 reduced motion 下仍建立 EQ 图但不启动视觉 RAF
- **歌词请求测试**:扩展 `lyrics-timeout.test.ts`,覆盖缓存命中时单个调用 abort、不取消共享请求,以及已 abort signal 立即拒绝
- **音乐服务测试**:扩展 `music-service.test.ts`,覆盖公开配置加载不请求 runtime config,以及歌单请求 URL 不包含 token
- **管理 API 测试**:新增 `src/tests/admin-api.test.ts`,覆盖 401/403 登录过期、25MiB 上传边界、部分删除失败、保存前配置校验、POST 更新检查、触发更新返回 `triggeredAt` / `triggerId`、更新状态查询
- **管理组件测试**:新增 `src/tests/admin-components.test.ts`,覆盖 8 位密码限制、部分删除失败时保留本地曲目、站点图标上传异步状态、移除 SVG 上传类型、预发布更新开关与代理提示文案
- **管理认证测试**:新增 `src/tests/use-admin-auth.test.ts`,覆盖 `disabled`、`env-not-ready`、普通初始化状态、非 JSON setup 响应、HTML setup 响应不写入文档
- **配置 schema 测试**:新增 `src/tests/config-schema.test.ts`,覆盖内部地址拦截、远程歌单 endpoint 要求、播放列表/本地曲目字段、可选统计配置、`receivePrereleaseUpdates` 布尔校验
- **路由安全测试**:扩展 `server/tests/router-security.test.ts`,覆盖未认证更新检查/状态查询、跨 Origin/Referer 写请求拒绝、同源写请求、开发 localhost 代理写请求、`/api/runtime-config` 404、非 JSON 更新请求 415、状态接口 no-store
- **更新流程测试**:扩展 `server/tests/update-handler.test.ts`,覆盖 stable / prerelease 比较、tag fallback、SemVer 排序、预发布 opt-in、私有 GitHub proxy 拒绝、缺 token 拒绝 dispatch、dispatch body、workflow run 状态归一化与 trigger id 过滤
- **上传安全测试**:扩展 `server/tests/upload-handler.test.ts`,覆盖允许的音乐资源和 raster icon,拒绝 service worker、manifest、robots、config/admin、可执行前端扩展、SVG、URL-like path、路径穿越、畸形编码、`.env`、workflow 文件,并覆盖删除 404 视为成功
- **配置/环境测试**:新增 `server/tests/config-handler.test.ts`、`development-mode.test.ts`、`url-validation.test.ts`,覆盖 fail-closed 配置读取、显式 `DEVELOPMENT`、环境校验和公网 URL 校验
- **公开配置生成测试**:新增 `server/tests/generate-public-config.test.ts`,覆盖缺失/明文/加密配置生成、解密失败、schema 失败、私密字段清洗、admin build status、`.dev.vars` 显式读取和 env 优先级
- **Bundle 泄漏测试**:新增 `server/tests/bundle-leakage.test.ts`,防止构建产物泄露 `apiToken`、`githubProxy` 等管理员字段和测试 secret
- **CI 验证链路**:PR、main、update workflow 均增加 `pnpm format:check`;update workflow 同步上游后运行安装、测试、类型检查、Lint、格式检查、构建,合并目标分支最新提交后再次运行测试、类型检查、构建

### Docs

- **README 本地开发说明更新**:端口从 5173 改为 5175,运行要求更新为 Node 22+ 与 pnpm 11.5.3+,并说明 `pnpm dev:full` 的 Vite + Wrangler Pages Functions 分工
- **README 管理后台说明更新**:高级设置补充预发布更新;保存配置说明改为构建期写入前端公开配置,首屏不再请求管理 API
- **README 一键更新说明重写**:补充临时分支、验证链路、失败不改目标分支、Actions 日志入口、branch protection 限制和保留用户数据规则
- **README 部署平台说明更新**:部署按钮表移除 GitHub Pages;Cloudflare Pages 改为说明 `wrangler.toml` 的 `pages_build_output_dir` 与 `_headers` / `_redirects`
- **README 环境变量表更新**:补充 `GITHUB_PROXY`、`DEVELOPMENT`,更新 `GH_TOKEN` 权限、`CONFIG_ENCRYPTION_KEY` 构建期用途,并移除 `/api/runtime-config` 例外描述
- **README 加密说明更新**:明确构建期会解密并清洗公开配置,`apiToken` 不进入前端 bundle,本地开发改用 `DEVELOPMENT=true`
- **`.env.example` / `.dev.vars.example` 更新**:明确 fine-grained PAT 需要 `Contents: Read and write` + `Actions: Write`,classic token 可用 `repo`;补充 GitHub 代理职责和 `api.github.com` 直连要求
- **SUPPORT 部署 FAQ 更新**:从“如何部署到 GitHub Pages”改为“支持哪些部署平台”,列出 Vercel、Netlify、Cloudflare Pages
- **agent.md 规范更新**:部署平台从 4 个收敛到 3 个,补充公开站点配置必须构建期生成、敏感字段不得进入前端 bundle、远程歌单不得预抓取 Meting 结果,并同步开发模式与环境变量口径

## [0.2.0-rc1] - 2026-06-24

### Added

- **管理后台**:新增完整的 Web 管理后台(前端 SPA + 后端 serverless API),访问 `/admin` 进入。支持首次初始化、密码登录、配置可视化编辑、文件上传、版本更新检查与触发,无需手动编辑仓库文件即可管理站点
- **`/setup` 初始化页面**:首次部署后访问 `/admin` 自动进入设置密码流程,密码经 PBKDF2-SHA256(100k 迭代 + 16 字节随机盐)哈希后存储到 `public/admin.json`,设置后 `/setup` 自动关闭(先到先得模型,利用 GitHub API 409/422 防并发初始化竞态)
- **配置文件全文加密**:`public/config.json` 与 `public/admin.json` 写入 GitHub 仓库时使用 AES-GCM 256 加密,密钥由 `CONFIG_ENCRYPTION_KEY` 经 PBKDF2(100k 迭代)派生,仓库中只存储 `v1:base64(salt+iv+ciphertext)` 密文;开发模式(`DEVELOPMENT=true`)不加密
- **`CONFIG_ENCRYPTION_KEY` 环境变量**:新增独立配置加密密钥,配置加密与 Cookie 签名均从它派生,与 `GH_TOKEN` 完全解耦,`GH_TOKEN` 可独立轮换而不影响已加密配置与已签发 Cookie;生产模式校验密钥强度(至少 32 位、拒绝全相同字符 / 纯顺序字符等弱模式)
- **`ADMIN_DISABLED` 环境变量**:设为 `true` 或 `1` 时禁用管理后台,`/admin` 显示"已禁用"页,除状态探针外所有 `/api/*` 返回 403;播放器公开配置改为构建期硬编译,不再依赖管理 API
- **Cookie 鉴权体系**(`server/core/auth.ts`):基于 HMAC-SHA256 签名的 7 天有效期 token(`payloadB64.sigB64`),HttpOnly + Secure + SameSite=Lax;签名密钥从 `CONFIG_ENCRYPTION_KEY` 派生;`tokenVersion` 机制——修改密码时自增并持久化,旧 Cookie 立即失效;`timingSafeEqual` 常量时间比较防时序侧信道
- **速率限制**(`server/core/rate-limit.ts`):登录 / 初始化 / 更新端点独立限流(滑动窗口 + 超限封禁),按 `key + IP + UserAgent` 维度,登录成功后重置计数;客户端 IP 优先取 `CF-Connecting-IP`
- **GitHub 持久化层**(`server/core/github.ts`):封装 Contents API 的文件读 / 写 / 删,8 秒超时,`sha` 乐观锁防并发覆盖,`GitHubWriteError` 携带 HTTP 状态码
- **版本更新检查与一键触发**(`server/core/update-handler.ts` + `.github/workflows/update-from-upstream.yml`):后台关于页检查上游 Release,完整 SemVer 实现(支持预发布版本比较);一键触发 `update-from-upstream.yml` workflow 拉取上游 release 到临时分支,验证通过后自动合并回目标分支(保留用户数据:`config.json` / `admin.json` / `icon.*` / `music/` 等均 exclude);支持 GitHub 代理(`{url}` 占位符或前缀拼接)
- **Meting API 连通性测试**(`server/core/music-api-tester.ts`):保存配置前并发测试所有启用歌单(并发 3),返回每个歌单的状态码 / 曲目数 / 错误信息与汇总结果,8 秒超时
- **本地音乐文件上传**(`upload-handler.ts` + `LocalTrackEditor.vue`):支持音频 / 封面 / 歌词 LRC 文件上传到 `public/music/{trackId}/`,50MB 限制,删除曲目时联动删除已上传文件;路径白名单(仅允许 `public/` 前缀)+ `new URL()` 规范化防路径穿越
- **站点图标上传**(`SiteSettingsEditor.vue`):支持 SVG / PNG / JPEG / WebP 图标上传到 `public/icon.{ext}`,本地开发模式用 DataURL 预览
- **远程歌单可视化编辑**(`PlaylistEditor.vue`):网易云 / QQ 音乐歌单的增删改 + 启用禁用,内联编辑(Dropdown 选服务器 + BaseInput 输入 ID),删除二次确认
- **统计与分析配置**(`AnalyticsSettingsEditor.vue` + `src/utils/site-integrations.ts`):Umami(自建 script URL + Website ID)、Google Analytics 4(Measurement ID)、Google 站点验证(Search Console)、自定义 CSS / 自定义 JS 注入,运行时动态 upsert / remove 元素
- **共享组件库**(`src/components/`):新增 `Collapse`(`grid-template-rows: 0fr→1fr` 动画)、`BaseInput`(`inheritAttrs` + `$attrs` 透传)、`BaseTextarea`、`Toast`(Teleport + Transition)、`Dropdown`(outside-click 封装)、`ConfirmModal`、`ToggleSwitch`、`SettingRange`(自动计算进度变量),管理后台与播放器统一复用
- **路由系统**:引入 `vue-router`,`AppShell.vue` 用 `<router-view>` + `<Transition mode="out-in">` 包裹;`/` 为播放器,`/admin` 懒加载管理后台;路由级淡入淡出
- **全局错误处理**:`main.ts` 添加 `app.config.errorHandler`;新增 `ErrorBoundary.vue` 用 `onErrorCaptured` 包裹 `router-view`,渲染出错时显示降级 UI + 重试按钮,避免白屏
- **服务器端状态页**(`server/core/status-pages.ts`):环境变量未就绪 / 管理后台禁用时由后端直接返回完整 HTML(内联深色玻璃拟态样式 + `escapeHtml` 防 XSS + 具体密钥生成命令),前端通过 Content-Type 检测后 `document.write` 接管页面
- **浏览器能力检测模块**(`src/utils/browser.ts`):集中管理 Safari 等浏览器兼容性差异——Fullscreen API(标准 + webkit 前缀 + iOS 不支持检测)、Document PiP、AudioContext(webkit 前缀)、Web Animations、iOS 设备检测(含 iPadOS 13+ 桌面 UA)、Safari 浏览器检测、iOS PWA 安装引导
- **`useFullscreen` 重写**:改用 `browser.ts` 的能力检测,iOS Safari 不支持 Fullscreen API 时引导用户使用浏览器菜单全屏,而非静默失败
- **Meting API 鉴权**:`services/music.ts` 的 `fetchPlaylist` 支持 `apiToken` 参数(查询字符串 `token`)
- **`robots.txt`**:新增 `public/robots.txt`,`Disallow: /admin/` 和 `/api/`
- **Cloudflare `_routes.json`**:限制只有 `/api/*` 走 Pages Functions,静态资源不产生 Functions 调用计费
- **动态 preconnect**:播放器使用构建期公开配置中的 `apiEndpoint` 动态创建 `<link rel="preconnect">`,移除 `index.html` 中写死的域名
- **多平台 API 路由**:Vercel(`api/[...path].ts`)、Cloudflare(`functions/api/[[path]].ts`)、Netlify(`netlify/functions/api.ts` + `netlify.toml` redirect)三平台统一入口
- **服务端独立 tsconfig**:`tsconfig.server.json` 用于 `server/` 目录类型检查
- **开发体验**:`package.json` 新增 `dev:admin`(wrangler pages dev :8788)与 `dev:full`(并行跑前端 + 后端);`vite.config.ts` 新增 `/api` 代理到 :8788,测试纳入 `server/tests/**/*.test.ts`
- **服务端单元测试**:新增 `admin-auth`、`admin-config-validation`、`crypto`、`router-security`、`update-handler`、`upload-handler` 共 6 个测试文件
- **`update-from-upstream.yml` workflow**:fork 仓库一键同步上游最新 release,支持 GitHub 代理,rsync 保留用户数据
- **主分支验证与发布自动化**:main 分支 workflow 负责测试、类型检查、lint、构建、打 tag;仅稳定版自动创建 GitHub Release(`--generate-notes --latest`)
- **`agent.md` 规范增补**:§3.1 模板内联事件禁止多语句、§3.3.1 共享组件库约束表、§4.2 路由 / 浮层过渡规范、§4.4 accent 半透明色 `color-mix` 派生规范

### Changed

- **环境变量模型**:生产环境需 `GH_TOKEN`、`GH_REPO`、`CONFIG_ENCRYPTION_KEY` 三项;`GH_BRANCH` 可选(默认 main)、`GITHUB_PROXY` 可选;密码通过 `/setup` 设置(不再使用 `ADMIN_PASSWORD`),Cookie 签名密钥从 `CONFIG_ENCRYPTION_KEY` 派生(不再使用 `ADMIN_SECRET`)
- **公开配置构建期硬编译**:播放器首屏不再请求后端配置 API,构建时从 `public/config.json` 生成公开配置并写入前端 bundle;远程歌单仍按 `apiEndpoint` 与歌单 ID 运行时请求 Meting API
- **`config-handler` 默认配置**:`config.json` 不存在时返回默认空配置(不再 404),首次部署开箱即用;读取失败、明文配置或解密失败时管理后台会明确报错,避免静默覆盖已有配置
- **`src/config/music.ts` 清理为纯净默认配置**:空 apiEndpoint、空数组,不再含个人数据;删除 `public/config.json`(由后台初始化创建)
- **`MusicConfig` 类型扩展**:新增 `siteIcon?`、`umami?`、`googleAnalytics?`、`googleSiteVerification?`、`customCss?`、`customJs?` 字段,与服务端 `ConfigPayload` 与 `validateConfig` 校验对齐
- **`App.vue` 重构**:启动时读取构建期公开配置 → `applySiteBrand`(动态设置 title + favicon)+ `applySiteIntegrations`(注入统计 / 自定义 CSS/JS);顶栏新增分享按钮;公开配置驱动站点名称显示
- **`main.ts` 重构**:挂载 `AppShell`(而非直接 `App`),注册 router 与全局 errorHandler
- **CSP 四处统一收紧**:`index.html` / `vercel.json` / `netlify.toml` / `wrangler.toml` 统一为 `script-src 'self' 'unsafe-inline' https:`、`connect-src 'self' https:`,不再写死 `api.music.abloom.site`、`googletagmanager.com`、`cloud.umami.is` 等具体域名
- **管理后台 accent 颜色派生**:`src/admin/` 下所有 `rgba(var(--accent-rgb), α)` 替换为 `color-mix(in srgb, var(--accent), transparent X%)`,确保用户自定义 `--accent` 时选中态 / 徽章跟随变化
- **CORS 头合规**:`router.ts` OPTIONS 预检的 `Access-Control-Allow-Origin` 从 `*` 改为反射请求 `Origin` 头,添加 `Vary: Origin`(允许 credentials 时 origin 不能为通配符)
- **`wrangler.toml`**:移除 `[build]` 段(构建命令改在 Cloudflare Dashboard 配置);修复 `Permissions-Policy` 中 `camera()` → `camera=()` 语法错误
- **`vercel.json`**:SPA rewrite 排除 `/api/*`(`source: "/((?!api/).*)"`)
- **`netlify.toml`**:新增 `functions`(esbuild bundler)与 `/api/*` → `/.netlify/functions/api/:splat` redirect
- **`pnpm-workspace.yaml`**:`allowBuilds` 新增 esbuild / sharp / workerd
- **`package.json`**:版本号 `0.1.1` → `0.2.0-rc1`;新增依赖 `vue-router`、`concurrently`、`npm-run-all2`、`wrangler`

### Fixed

- **`usePreloadPool` 事件监听器泄漏**:`PreloadSlot` 新增 `cleanup` 字段,`clearSlot` 与超时回调统一调用 `cleanup()` 移除 `canplay` / `loadeddata` / `error` 监听器
- **`useLyricsWindow` 竞态条件**:`toggleLyricsWindow` 添加 `isToggling` 守卫,快速重复调用时第二次直接返回;`waitForDocumentReady` 的 interval 改为可清理,`teardownWindow` 会清理它
- **`useThemeAccent` rAF 未清理**:`onBeforeUnmount` 取消颜色过渡动画帧
- **`useDrawerSheet` timer 泄漏**:`dismissAnimated` 的 `setTimeout` 与 `watch(active)` 的双层 `requestAnimationFrame` 存储 ID,`onBeforeUnmount` 清理
- **`useFocusTrap` setTimeout 未清理**:`deactivateTrap` 的 `setTimeout` 存储到 `focusTimer`,卸载时清理
- **`useBeatAnalyser` 卸载后多余 rAF**:添加 `isUnmounted` 标志,`await audioContext.resume()` 后检查,已卸载则不启动新 rAF
- **`upload-handler` 路径穿越**:`public/../server/core/router.ts` 可绕过 `startsWith('public/')` 检查,改用 `new URL()` 规范化路径后校验,拒绝空字节
- **`DashboardView` 模板类型错误**:`@notify` 事件处理器在 `vue-tsc -b` 下 `$event[1]` 推断为 `string` 而非 `'success' | 'error'`,改为显式参数类型注解
- **模板内联事件多语句编译错误**:`@click="a(); b()"` 会被 Prettier 拆分号导致 Vue 编译器报 `Unexpected token, expected ","`,改用方法引用或包装函数
- **管理后台首次访问闪现 LoginView**:`checking` 初始值从 `false` 改为 `true`,首帧显示"正在验证"而非 LoginView
- **浮层 fixed 定位被困在父容器内**:`ConfirmModal` / `Toast` 使用 `<Teleport to="body">` 避免被 `backdrop-filter` / `transform` 父容器建立包含块
- **`ADMIN_DISABLED` 拦截管理 API**:禁用管理后台时仅状态探针可访问,播放器公开配置已改为构建期硬编译,不再需要运行时配置接口

## [0.1.1] - 2026-06-22

### Added

- 五频段均衡器(Equalizer):新增 `src/utils/equalizer.ts`(DOM-free 纯模块)+ `src/composables/useEqualizer.ts`,采用 Web Audio `BiquadFilterNode` 串联(`lowshelf` → `peaking×3` → `highshelf`),覆盖 60Hz / 250Hz / 1kHz / 4kHz / 12kHz 五个常用频段,增益范围 ±12 dB
- 6 个内置预设(平坦 / 流行 / 摇滚 / 爵士 / 人声 / 低音增强)+ 1 个"自定义"动态状态指示器:用户拖动任意频段滑块后,预设状态自动切换为"自定义"(`detectPreset` 兜底),也可以直接点击"自定义"按钮显式停留在自定义模式
- EQ 状态完整接入 `PlayerSettings` 持久化与 `migrateSettings` 嵌套合并;`sanitizeEqualizer` 对历史数据做容错(无字段时回落默认值、非法预设回落 `flat`、频段值钳制到 ±12dB)
- 设置抽屉新增"音效"section:开关 + 6 预设按钮(末尾"自定义"状态斜体区分)+ 5 频段滑块,均衡器关闭时所有按钮统一灰色(包括激活的预设),开启时 active 预设带 accent 高亮
- 频谱可视化重新设计:四柱采用**互质步长 + 不同起点**的交叉跳跃采样(`step` ∈ {7, 11, 13, 17}),每柱在频域上做伪随机扫描,任意两柱重叠 bin 极少;配合 `weightDecay` 频段偏好系数(柱 1 偏低频 0.92,柱 4 偏高频 1.06)与每柱独立的不对称时间常数(`riseSpeeds` / `fallSpeeds`),四柱在时间维度上完全脱钩,任何瞬间高度组合明显不同
- `equalizer.test.ts` 新增 26 个纯函数测试,覆盖预设 / 增益钳制 / 数据消毒 / 兜底逻辑

### Changed

- `TrackList` 播放中频谱柱从"底基线对齐"(`align-items: flex-end`)改为"中线对称扩展"(`align-items: center`),柱子上下端均圆角(`border-radius: 999px`),视觉风格对齐 Apple Music
- `useBeatAnalyser` 的 EQ filter chain 在 graph 首次构建时插入到 `MediaElementSource` 与 `Analyser` 之间,通过 `onEqFiltersReady` 回调暴露给 `useEqualizer`(`createMediaElementSource` 一次性约束下的唯一可行布线方式)
- 设置抽屉中"音量""定时关闭""歌词字号""背景模糊""背景饱和度""节奏亮度"等 label 文字补回 `<strong>` 包裹,与"平滑切歌""动态封面背景"等 toggle 项字号 / 字重 / 颜色完全统一(共用 `.setting-group strong` 的 `0.8rem / 560 / #fff`)
- `useFocusTrap` 改造为 `nextTick` 异步流程并加入 `pendingActivation` 守卫:容器节点 / 可聚焦元素首次渲染晚于激活时,会在 `nextTick` / `watch(containerRef)` / `onMounted` 三个时机重试,杜绝"抽屉打开但焦点没进入"的边界场景
- `usePwaInstall` 的 `install()` 改为 `try / finally` 结构,保证 `prompt()` 或 `userChoice` 抛错时也能清空 `deferredPrompt` 引用,避免 stale 状态阻塞下一次弹窗
- 更新检查统一收敛到后台 `server/core/update-handler.ts`:GitHub Releases / Tags API 请求统一加 8 秒超时,严格 SemVer 排序并按后台配置决定是否接收预发布版本,避免前台和后台两套逻辑分叉
- `pnpm-workspace.yaml` 新增 `overrides` 锁定传递依赖 `ini >=1.3.6` / `undici >=7.28.0`,堵住 pnpm 锁文件中的若干已知安全告警
- `agent.md §3.1` 修正:格式约定从"**写**分号"改为"**不写**分号"(与项目 prettier 实际配置 `semi: false` 一致)

### Fixed

- 修复更新链路取消与失败反馈:后台关于页卸载时会取消检查/状态轮询,网络失败不再写入前台长时间负缓存,失败原因统一显示在后台状态卡片中
- 修复 `usePwaInstall` 接受 / 拒绝两种 `userChoice.outcome` 路径下 `deferredPrompt` 引用残留导致的"二次安装"失效问题
- 修复 `useFocusTrap.deactivateTrap` 中对 `triggerRef.value?.focus()` 的延迟读取:`setTimeout` 触发时 `triggerRef.value` 可能已经被新一轮 activate 覆盖,改为闭包捕获 `trigger` 局部变量

### Performance

- 频谱采样从"连续频段区间累加 + 单一峰值归一化"重构为"交叉跳跃采样 + 每柱独立 sigmoid 响应曲线 + 不对称时间常数",消除"四柱齐刷刷顶满或归零"现象,在不同曲风(电子 / 流行 / 摇滚 / 钢琴)下视觉差异始终保持

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
- 多平台部署配置:Vercel(`vercel.json`)、Cloudflare Pages(`wrangler.toml`)、Netlify(`netlify.toml`)
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

[0.2.0-rc2]: https://github.com/abloom25/Meliora/releases/tag/v0.2.0-rc2
[0.2.0-rc1]: https://github.com/abloom25/Meliora/releases/tag/v0.2.0-rc1
[0.1.1-rc.3]: https://github.com/abloom25/Meliora/releases/tag/v0.1.1-rc.3
[0.1.1-rc.2]: https://github.com/abloom25/Meliora/releases/tag/v0.1.1-rc.2
[0.1.1-rc.1]: https://github.com/abloom25/Meliora/releases/tag/v0.1.1-rc.1
[0.1.0]: https://github.com/abloom25/Meliora/releases/tag/v0.1.0
