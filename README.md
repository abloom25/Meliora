<div align="center">

<img src="public/pwa-icon.svg" alt="Meliora" width="100" height="100" />

# Meliora

**沉浸式 · 视听一体的网页音乐播放器**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg?style=flat-square)](LICENSE)
[![Vue 3](https://img.shields.io/badge/Vue-3.5-42b883?style=flat-square&logo=vue.js&logoColor=white)](https://vuejs.org/)
[![Vite](https://img.shields.io/badge/Vite-8-646cff?style=flat-square&logo=vite&logoColor=white)](https://vite.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PWA](https://img.shields.io/badge/PWA-Ready-5a0fc8?style=flat-square&logo=pwa&logoColor=white)](https://web.dev/progressive-web-apps/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

[特性](#-特性) · [快速开始](#-快速开始) · [管理后台](#-管理后台) · [快捷键](#-快捷键) · [部署](#-部署) · [开发](#-开发) · [路线图](ROADMAP.md)

[在线预览](https://music.abloom.site) · [反馈问题](https://github.com/abloom25/Meliora/issues) · [贡献指南](CONTRIBUTING.md)

</div>

---

## ✨ 特性

### 视听一体

- 🎨 **实时节拍分析**:Web Audio API 频谱采样驱动背景呼吸效果,封面取色驱动全局主题色过渡
- 🌈 **动态背景**:封面模糊渲染 + 可调节模糊/饱和度/节奏亮度,支持关闭
- 🎵 **零延迟切歌**:三 Audio 池 + 预加载槽 + 平滑切歌淡入淡出

### 歌词体验

- 📜 **LRC 歌词跟随**:FLIP 牵引滚动 + 逐行高亮 + 可调字号
- 🪟 **歌词小窗**:Document Picture-in-Picture 独立浮窗,支持在外部应用时查看歌词

### 播放控制

- 🎚️ **内置均衡器**:10 频段增益调节 + 预设方案
- ⏰ **定时关闭**:倒计时自动停止播放
- 🔀 **播放模式**:顺序 / 随机 / 单曲循环
- ⏭️ **自动跳过**:加载失败自动跳到下一首

### 沉浸模式

- 📱 **全屏模式**:一键占满整个屏幕
- 👻 **自动隐藏**:鼠标闲置 30 秒后只保留歌曲内容
- 📳 **触感反馈**:移动端切歌/操作轻震动

### 平台集成

- 📲 **PWA 安装**:可添加到桌面,支持离线启动
- 🔒 **MediaSession**:锁屏 / 控制中心播放控制
- 🔗 **歌曲分享**:Web Share API 分享当前曲目

### 曲库管理

- 🌐 **远程歌单**:网易云 / QQ 音乐歌单,通过 Meting API 解析
- 💾 **本地音乐**:上传音频/封面/歌词,自动合并去重
- ⚙️ **可视化管理**:完整的 Web 管理后台,无需编辑代码

### 无障碍

- ♿ `prefers-reduced-motion` 支持
- ⌨️ 完整键盘快捷键 + focus trap
- 🎨 颜色 + 图标双重状态提示

---

## 🚀 快速开始

```powershell
pnpm install
pnpm dev          # 仅前端(5175)
pnpm dev:full     # 前端 + 后端模拟(5175 + 8788)
```

需要 Node 22+ 与 pnpm 11.5.3+。

- `pnpm dev`:仅启动 Vite 前端开发服务器,默认端口 5175,适合纯 UI 开发
- `pnpm dev:full`:同时启动 Vite + Wrangler Pages Functions 本地模拟,`/api/*` 请求代理到 8788 端口,可完整测试管理后台(含 `/setup` 初始化流程)。Wrangler 使用 `.wrangler/pages-dev-static` 临时静态目录启动本地 Functions,静态页面仍由 Vite 提供,不依赖 `dist` 是否存在或是否最新。

本地后端可使用开发模式(`.dev.vars` 中 `DEVELOPMENT=true`),配置和密码不持久化,重启即重置。复制 [.dev.vars.example](.dev.vars.example) 为 `.dev.vars` 并填入真实 GitHub Token、关闭 `DEVELOPMENT` 后可测试完整流程。

---

## ⚙️ 管理后台

访问 `https://你的域名/admin` 进入管理后台。

### 首次使用

部署后首次访问 `/admin` 会进入 `/setup` 页面,设置管理员密码即可。密码经 PBKDF2 哈希后存储,后续可在后台「安全」页面修改。

### 后台功能

| 页面         | 功能                                       |
| ------------ | ------------------------------------------ |
| **站点**     | 站点名称、图标、Meting API 端点、API Token |
| **歌单**     | 添加/删除/启用网易云与 QQ 音乐歌单         |
| **本地音乐** | 上传音频/封面/歌词,编辑曲目信息            |
| **统计**     | Umami / Google Analytics 配置              |
| **高级**     | GitHub 代理、预发布更新、自定义 CSS / JS   |
| **安全**     | 修改管理员密码                             |
| **关于**     | 版本信息、检查更新、同步上游代码           |

保存配置时,后台通过 GitHub API 将变更写入仓库 `public/config.json`,触发部署平台自动重新构建后生效。播放器公开配置在构建期写入前端 bundle,首屏不再请求管理 API;远程歌单仍按 `apiEndpoint` 与歌单 ID 实时请求 Meting API,不会把歌曲列表结果预构建进前端。

### 更新说明

管理后台「关于」页的一键更新用于同步官方上游版本,适合未修改源码、仅通过后台维护配置和曲库的部署。

用户只需要点击一次“更新”。后台会触发 GitHub Actions,Actions 在 `meliora-update/*` 临时分支里同步上游代码,运行依赖安装、测试、类型检查、Lint、格式检查与构建;验证通过后再合并目标分支最新提交并执行关键验证,无冲突才自动合并并推送回目标分支。

失败、冲突或推送被拒绝时目标分支保持不变,后台会显示运行状态、失败原因和 GitHub Actions 日志入口,不需要用户手动 merge。流程会保留 `public/config.json`、`public/admin.json`、`public/music/`、`.github/workflows/`、`.prettierignore`、`.env`、`.env.local`、`.dev.vars` 和构建产物等部署数据;`.env.example`、`.dev.vars.example` 等模板文件会随上游更新。

新版更新协议把工作流视为部署仓库自己的固定启动器:普通代码、UI、后端和依赖升级不会改写 `.github/workflows/`,因此只使用 Actions 自动提供的 `GITHUB_TOKEN` 即可推送验证后的业务代码,不需要再给 Actions 单独配置高权限 PAT。工作流本身若需要升级,必须单独手动同步;这不会阻塞日常版本更新。

> **不向下兼容:**旧版部署需要手动同步或重新部署一次才能进入新版更新协议。进入新版后,日常上游升级为后台一键完成。

如果仓库启用了 branch protection 且禁止 `github-actions[bot]` push,自动合并会失败,需要允许 GitHub Actions 写入目标分支,或后续改用 PR auto-merge 模式。如果你已经修改过源码、样式、工作流或部署配置,请不要使用后台一键更新,应自行通过 Git 合并上游代码并处理冲突。

---

## ⌨️ 快捷键

| 快捷键        | 操作             |
| ------------- | ---------------- |
| `Space`       | 播放 / 暂停      |
| `←` / `→`     | 后退 / 快进 5 秒 |
| `Shift + ←/→` | 上一曲 / 下一曲  |
| `L`           | 切换歌词面板     |
| `S`           | 打开设置抽屉     |
| `F`           | 切换全屏         |
| `M`           | 静音切换         |
| `Esc`         | 关闭抽屉 / 弹层  |

输入框中自动让出快捷键。

---

## 🌍 部署

一键部署到以下平台(点击图标,Fork 后自动构建):

| 平台                 | 一键部署                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vercel**           | [![Deploy](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fabloom25%2FMeliora)                                                                                                |
| **Netlify**          | [![Deploy](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/abloom25/Meliora)                                                                                  |
| **Cloudflare Pages** | [![Deploy to Cloudflare Pages](https://img.shields.io/badge/Deploy-Cloudflare%20Pages-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://deploy.workers.cloudflare.com/?url=https://github.com/abloom25/Meliora) |

### 环境变量

部署后在平台 Dashboard 的 Settings → Environment Variables 中配置环境变量:

| 变量                    | 必填 | 说明                                                                                                                                                                                        |
| ----------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GH_TOKEN`              | ✅   | 部署运行时使用的 GitHub Personal Access Token。Fine-grained token 需要 `Contents: Read and write` + `Actions: Write`; classic token 可使用 `repo` 权限。无需再复制到 GitHub Actions Secrets |
| `GH_REPO`               | 条件 | 仓库标识,`owner/repo` 格式。Vercel 开启 System Environment Variables 后会从 `VERCEL_GIT_REPO_OWNER` / `VERCEL_GIT_REPO_SLUG` 自动推导,其他平台需填写                                        |
| `CONFIG_ENCRYPTION_KEY` | ✅   | 配置加密密钥,32 位以上随机字符串。配置加密、Cookie 签名与构建期公开配置生成都依赖它,GH_TOKEN 可独立轮换而不影响已加密配置                                                                   |
| `GH_BRANCH`             | ❌   | 目标分支。优先使用显式值,Vercel 可从 `VERCEL_GIT_COMMIT_REF` 自动推导,其余情况默认 `main`                                                                                                   |
| `GITHUB_PROXY`          | ❌   | GitHub 代理,必须是公网 HTTPS URL。用于检查更新和 workflow 内拉取上游代码;触发 workflow 与查询 Actions 状态仍需部署环境可访问 `api.github.com`                                               |
| `ADMIN_DISABLED`        | ❌   | 设为 `true`/`1`/`yes`/`on`(大小写不敏感)时禁用管理后台,`/admin` 显示“已禁用”,除状态探针外所有 `/api/*` 返回 403                                                                             |
| `DEVELOPMENT`           | ❌   | 设为 `true`/`1`/`yes`/`on`(大小写不敏感)时进入开发模式:配置与密码不持久化、加密走明文降级                                                                                                   |

> 生成 `CONFIG_ENCRYPTION_KEY`:`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

> `CONFIG_ENCRYPTION_KEY` 需要同时提供给平台的构建环境和 Functions/运行时环境。构建期会用它解密 `public/config.json`,生成前端公开配置;如果仓库中已有密文配置但构建阶段缺少该变量,构建会失败以避免站点静默变成空配置。

> GitHub Actions 验证固定读取 `.github/ci-public-config.json`,不会解密生产配置,因此不需要把 `CONFIG_ENCRYPTION_KEY` 复制到 GitHub Secrets。生产平台构建仍会严格要求真实密钥。

> ### 🎉 零配置密码
>
> 首次部署后访问 `/admin`,会自动进入 `/setup` 页面设置管理员密码——**无需在环境变量中预设任何密码**。
>
> - **密码**:通过 `/setup` 页面设置,经 PBKDF2(100k 迭代)哈希后存储在仓库 `public/admin.json`,后续可在后台修改
> - **Cookie 签名密钥**:从 `CONFIG_ENCRYPTION_KEY` 运行时派生(`HMAC-SHA256(密钥, "meliora-cookie-signing")`),**不落盘、不出现在任何文件/响应/日志中**
> - **密钥强度校验**:初始化时若 `CONFIG_ENCRYPTION_KEY` 未设置或过弱(< 32 位 / 常见弱密钥),`/setup` 页面会显示警告并拒绝初始化,提示用户在部署平台配置后再试
> - **先到先得**:部署后谁先访问 `/setup` 谁设置密码,设置后 `/setup` 自动关闭

> ### 🔒 配置文件加密
>
> 管理后台保存的所有配置(站点信息、API Token、歌单、Umami / GA ID 等)在写入 GitHub 仓库时**全文 AES-GCM 256 加密**,仓库中只存储 base64 密文。构建期会从中生成公开播放器配置,但 `apiToken` 不会进入前端 bundle;需要 token 的 Meting API 后续应通过专门后端代理支持。
>
> - **加密密钥**:从 `CONFIG_ENCRYPTION_KEY` 用 PBKDF2(100k 迭代)派生,密钥本身**不落盘、不出现在任何文件中**
> - **密钥解耦**:`CONFIG_ENCRYPTION_KEY` 专用于加密与签名,`GH_TOKEN` 仅用于 GitHub API 读写,两者独立——`GH_TOKEN` 可随时轮换而不影响已加密的配置
> - **加密范围**:`public/config.json`(站点配置)和 `public/admin.json`(密码哈希)均为密文存储
> - **构建期公开配置**:构建脚本解密并清洗站点公开配置后写入前端 bundle;直接访问仓库文件或 `/admin.json` 只能看到密文
> - **本地开发**:`DEVELOPMENT=true` 时不加密,明文存内存,方便调试

### 各平台说明

<details>
<summary><strong>Vercel</strong></summary>

已包含 `vercel.json`,导入仓库后自动部署。

- 框架:Vite(自动识别)
- 构建命令:`pnpm build`
- 输出目录:`dist`
- 安装命令:`pnpm install --frozen-lockfile`(配置文件已指定)
- 安全头(CSP / X-Content-Type-Options / X-Frame-Options / Referrer-Policy / Permissions-Policy)、Service Worker 缓存策略、静态资源 immutable 缓存、SPA fallback 均已在 [vercel.json](vercel.json) 配置

</details>

<details>
<summary><strong>Netlify</strong></summary>

已包含 [netlify.toml](netlify.toml),接入仓库后自动识别。

- 构建命令:`pnpm build`(配置文件已指定)
- 发布目录:`dist`(配置文件已指定)
- 运行环境:Node 22 + pnpm 11.5.3(配置文件已指定)
- 安全头、Service Worker 缓存策略、静态资源 immutable 缓存、SPA fallback 均已配置

</details>

<details>
<summary><strong>Cloudflare Pages</strong></summary>

已包含 [wrangler.toml](wrangler.toml),可通过控制台导入或 `wrangler pages deploy dist` 部署。

- 构建命令:`pnpm build`
- 输出目录:`dist`
- `wrangler.toml` 已设置 `pages_build_output_dir = "dist"`
- 安全头、Service Worker 缓存策略、静态资源 immutable 缓存、SPA fallback 通过 [public/\_headers](public/_headers) 与 [public/\_redirects](public/_redirects) 配置,构建时会复制到 `dist`

</details>

所有平台配置统一:构建命令 `pnpm build`、输出目录 `dist`,并保持安全头与缓存策略一致。Node 版本遵循 `package.json` 的 `engines` 要求,Netlify 额外在 `netlify.toml` 中固定构建环境版本。

---

## 🛠️ 开发

```powershell
pnpm dev          # 开发服务器(前端)
pnpm dev:full     # 开发服务器(前端 + 后端模拟)
pnpm test         # 单元测试
pnpm type-check   # 类型检查
pnpm lint         # ESLint
pnpm format       # Prettier
pnpm build        # 生产构建
```

### 本地配置同步

`DEVELOPMENT=true` 时,管理后台的配置与密码仍由本地后端以内存模式处理,重启后会重置。为了让主页保持与生产一致的“构建期公开配置”读取方式,Vite 开发服务器会在后台保存配置成功后,把配置同步写入 `.meliora/config.local.json`,并重新生成 `src/generated/public-config.ts`。

- `.meliora/` 已加入 `.gitignore`,仅用于本地调试。
- 主页不会请求运行时配置接口,仍然只读取生成后的公开配置。
- 重新执行 `pnpm generate:public-config:dev` 时,如果 `.meliora/config.local.json` 存在,会优先用它生成本地公开配置。
- 要测试真实生产链路,请关闭 `DEVELOPMENT`,配置真实 `GH_TOKEN` / `GH_REPO` / `CONFIG_ENCRYPTION_KEY`,让后台写入仓库后再构建。

### 项目结构

```
src/
├── components/      共享 UI 组件(ConfirmModal / ToggleSwitch / Toast 等)
├── composables/     业务 hook(useAudioPlayer / useBeatAnalyser 等)
├── stores/          Pinia 状态管理
├── services/        远程 IO 抽象(Meting API / 歌词)
├── utils/           纯函数工具(无副作用、无 DOM 依赖)
├── workers/         Web Worker(主题色提取)
├── admin/           管理后台(独立子应用)
│   ├── components/  后台 UI 组件
│   ├── views/       后台页面(Setup / Login / Dashboard / About)
│   └── services/    后台 API 服务
└── styles/          全局样式

server/              Edge Functions 后端
├── core/            核心逻辑(路由 / 鉴权 / 配置 / 上传)
└── tests/           后端测试

api/                 Vercel Edge Function 入口
functions/           Cloudflare Pages Function 入口
netlify/             Netlify Function 入口
```

提交时 Husky 会自动运行 `lint-staged` 与 `commitlint`。提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)。

---

## 🤝 贡献

欢迎一切形式的贡献。详情请看 [CONTRIBUTING.md](CONTRIBUTING.md);代码风格与设计规范请看 [agent.md](agent.md)。

---

## 📄 开源许可

[GNU Affero General Public License v3.0 or later](LICENSE) © abloom25

> AGPL-3.0 要求任何**修改后部署到公网**的衍生版本必须向用户提供完整源代码。如需闭源商业使用,请联系作者协商授权。

---

<div align="center">

如果这个项目对你有帮助,欢迎点亮 ⭐ Star

Made with ❤️ by [abloom25](https://github.com/abloom25) and OpenAI Codex

</div>
