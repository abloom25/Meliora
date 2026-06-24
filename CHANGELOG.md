# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0-rc1] - 2026-06-24

### Added

- **管理后台**:新增完整的 Web 管理后台(前端 SPA + 后端 serverless API),访问 `/admin` 进入。支持首次初始化、密码登录、配置可视化编辑、文件上传、版本更新检查与触发,无需手动编辑仓库文件即可管理站点
- **`/setup` 初始化页面**:首次部署后访问 `/admin` 自动进入设置密码流程,密码经 PBKDF2-SHA256(100k 迭代 + 16 字节随机盐)哈希后存储到 `public/admin.json`,设置后 `/setup` 自动关闭(先到先得模型,利用 GitHub API 409/422 防并发初始化竞态)
- **配置文件全文加密**:`public/config.json` 与 `public/admin.json` 写入 GitHub 仓库时使用 AES-GCM 256 加密,密钥由 `CONFIG_ENCRYPTION_KEY` 经 PBKDF2(100k 迭代)派生,仓库中只存储 `v1:base64(salt+iv+ciphertext)` 密文;本地开发模式(`GH_TOKEN` 为空或 `placeholder` / `ghp_xxx` 开头)不加密
- **`CONFIG_ENCRYPTION_KEY` 环境变量**:新增独立配置加密密钥,配置加密与 Cookie 签名均从它派生,与 `GH_TOKEN` 完全解耦,`GH_TOKEN` 可独立轮换而不影响已加密配置与已签发 Cookie;生产模式校验密钥强度(至少 32 位、拒绝全相同字符 / 纯顺序字符等弱模式)
- **`ADMIN_DISABLED` 环境变量**:设为 `true` 或 `1` 时禁用管理后台,`/admin` 显示"已禁用"页,所有管理 API 返回 403(`/api/runtime-config` 与 `/api/setup-status` 除外,确保播放器正常加载配置)
- **Cookie 鉴权体系**(`server/core/auth.ts`):基于 HMAC-SHA256 签名的 7 天有效期 token(`payloadB64.sigB64`),HttpOnly + Secure + SameSite=Lax;签名密钥从 `CONFIG_ENCRYPTION_KEY` 派生;`tokenVersion` 机制——修改密码时自增并持久化,旧 Cookie 立即失效;`timingSafeEqual` 常量时间比较防时序侧信道
- **速率限制**(`server/core/rate-limit.ts`):登录 / 初始化 / 更新端点独立限流(滑动窗口 + 超限封禁),按 `key + IP + UserAgent` 维度,登录成功后重置计数;客户端 IP 优先取 `CF-Connecting-IP`
- **GitHub 持久化层**(`server/core/github.ts`):封装 Contents API 的文件读 / 写 / 删,8 秒超时,`sha` 乐观锁防并发覆盖,`GitHubWriteError` 携带 HTTP 状态码
- **版本更新检查与一键触发**(`server/core/update-handler.ts` + `.github/workflows/update-from-upstream.yml`):后台关于页检查上游 Release,完整 SemVer 实现(支持预发布版本比较);一键触发 `update-from-upstream.yml` workflow 拉取上游 release 并 rsync 同步代码(保留用户数据:`config.json` / `admin.json` / `icon.*` / `music/` 等均 exclude);支持 GitHub 代理(`{url}` 占位符或前缀拼接)
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
- **动态 preconnect**:`loadRuntimeConfig` 拿到 `apiEndpoint` 后动态创建 `<link rel="preconnect">`,移除 `index.html` 中写死的域名
- **多平台 API 路由**:Vercel(`api/[...path].ts`)、Cloudflare(`functions/api/[[path]].ts`)、Netlify(`netlify/functions/api.ts` + `netlify.toml` redirect)三平台统一入口
- **服务端独立 tsconfig**:`tsconfig.server.json` 用于 `server/` 目录类型检查
- **开发体验**:`package.json` 新增 `dev:admin`(wrangler pages dev :8788)与 `dev:full`(并行跑前端 + 后端);`vite.config.ts` 新增 `/api` 代理到 :8788,测试纳入 `server/tests/**/*.test.ts`
- **服务端单元测试**:新增 `admin-auth`、`admin-config-validation`、`crypto`、`router-security`、`update-handler`、`upload-handler` 共 6 个测试文件
- **`update-from-upstream.yml` workflow**:fork 仓库一键同步上游最新 release,支持 GitHub 代理,rsync 保留用户数据
- **GitHub Pages SPA 404 fallback**:`deploy-pages.yml` 新增 `cp dist/index.html dist/404.html`,刷新子路由不再 404
- **Release 自动化**:`deploy-pages.yml` 区分稳定版与预发布版(`-alpha` / `-beta` / `-rc` / `-pre` / `-preview`),仅稳定版自动创建 GitHub Release(`--generate-notes --latest`)
- **`agent.md` 规范增补**:§3.1 模板内联事件禁止多语句、§3.3.1 共享组件库约束表、§4.2 路由 / 浮层过渡规范、§4.4 accent 半透明色 `color-mix` 派生规范

### Changed

- **环境变量模型**:生产环境需 `GH_TOKEN`、`GH_REPO`、`CONFIG_ENCRYPTION_KEY` 三项;`GH_BRANCH` 可选(默认 main)、`GITHUB_PROXY` 可选;密码通过 `/setup` 设置(不再使用 `ADMIN_PASSWORD`),Cookie 签名密钥从 `CONFIG_ENCRYPTION_KEY` 派生(不再使用 `ADMIN_SECRET`)
- **`loadRuntimeConfig` 统一走后端 API**:不再区分 DEV / PROD,统一 `fetch('/api/runtime-config')`;后端不可用(GitHub Pages)时 fallback 到 `musicConfig`(打包时静态默认配置)
- **`config-handler` 默认配置**:`config.json` 不存在时返回默认空配置(不再 404),首次部署开箱即用;解密失败时 fallback 到默认配置(向后兼容旧明文)
- **`src/config/music.ts` 清理为纯净默认配置**:空 apiEndpoint、空数组,不再含个人数据;删除 `public/config.json`(由后台初始化创建)
- **`MusicConfig` 类型扩展**:新增 `siteIcon?`、`umami?`、`googleAnalytics?`、`googleSiteVerification?`、`customCss?`、`customJs?` 字段,与服务端 `ConfigPayload` 与 `validateConfig` 校验对齐
- **`App.vue` 重构**:启动时 `loadRuntimeConfig` → `applySiteBrand`(动态设置 title + favicon)+ `applySiteIntegrations`(注入统计 / 自定义 CSS/JS);顶栏新增分享按钮;`runtimeConfig` 驱动站点名称显示
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
- **`ADMIN_DISABLED` 拦截 `/api/runtime-config`**:禁用管理后台时播放器无法加载配置,现已放行 `GET /api/runtime-config`

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
- `services/updates.ts` 引入 `composeTimeoutSignal` 组合器:GitHub Releases / Tags API 请求统一加 8 秒超时,与用户提供的 `AbortSignal` 双向联动(用户取消立即透传,超时只 abort 内部 controller),失败后写空缓存,杜绝"API 永远不返回"导致更新检查 hang 死的情况
- `pnpm-workspace.yaml` 新增 `overrides` 锁定传递依赖 `ini >=1.3.6` / `undici >=7.28.0`,堵住 pnpm 锁文件中的若干已知安全告警
- `agent.md §3.1` 修正:格式约定从"**写**分号"改为"**不写**分号"(与项目 prettier 实际配置 `semi: false` 一致)

### Fixed

- 修复 `services/updates.ts` 的 abort 判定逻辑:`isAbortError` 在 `signal` 已 abort 时仍会被 catch 误吞,现改为直接判定 `signal?.aborted`,杜绝外部取消信号被静默丢弃
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

[0.2.0-rc1]: https://github.com/abloom25/Meliora/releases/tag/v0.2.0-rc1
[0.1.1-rc.3]: https://github.com/abloom25/Meliora/releases/tag/v0.1.1-rc.3
[0.1.1-rc.2]: https://github.com/abloom25/Meliora/releases/tag/v0.1.1-rc.2
[0.1.1-rc.1]: https://github.com/abloom25/Meliora/releases/tag/v0.1.1-rc.1
[0.1.0]: https://github.com/abloom25/Meliora/releases/tag/v0.1.0
