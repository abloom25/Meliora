# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[0.1.1-rc.2]: https://github.com/abloom25/Meliora/releases/tag/v0.1.1-rc.2
[0.1.1-rc.1]: https://github.com/abloom25/Meliora/releases/tag/v0.1.1-rc.1
[0.1.0]: https://github.com/abloom25/Meliora/releases/tag/v0.1.0
