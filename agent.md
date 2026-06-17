# agent.md

本文件用于约束 AI Agent 在本仓库中协作时的代码风格与设计风格。Agent 在执行任何修改、新增、重构任务前,**必须**先阅读本文件,并在产出代码、组件、样式、文档时严格遵守。

---

## 0. 学习与扩展机制(最高优先级,务必严格遵守)

本节是 agent.md 的元规则,**优先级高于本文件其他所有章节**。任何对 agent.md 的修改都必须遵循本节流程,**不存在任何例外**。

### 0.1 何时触发本机制

只要 Agent 在工作过程中产生**任何**形式的"想要写入或修改 agent.md"的念头,无论触发场景多么"显而易见"或"理所当然",都属于本机制管辖范围。常见触发场景包括但不限于:

- 完成新功能/新配置后,**自发**地认为应该把这次的做法沉淀为规范
- 用户提出某个改动后,**自发**地认为这个改动应该被记入 agent.md
- 发现项目缺少某种规范,**自发**地认为应该补上
- 发现新的代码模式、架构习惯、约束条件
- 用户的某句话"看起来像"在认可一条规范
- 用户的某句话"看起来像"在让 Agent 沉淀文档

> ⚠️ **关键判断**:**用户没有明确说"把 X 写入 agent.md"或"把这条记录到 agent.md",就一律视为未授权**。即使用户认可了某个做法,也只是认可"这次这么做",**不等于**授权写入 agent.md。

### 0.2 强制流程(三步)

发现需要新增或修改规范时,**必须严格按以下三步执行,不得省略、合并、提前**:

1. **STOP** —— 立刻停止动手修改 agent.md,**不要先写后问**。
2. **PROPOSE** —— 用自然语言向用户清晰提出建议,内容包括:
   - 提议的规范完整文本(用户可直接复制使用的最终版本)
   - 出现的背景或触发场景
   - 建议归入哪一节(明确章节号 §1 ~ §11)
   - 与现有条款是否冲突,冲突点是什么
   - 不写入会有什么后果
3. **WAIT** —— 等待用户**明确**的肯定指令,例如:
   - "写入"、"加进去"、"记到 agent.md"、"补到 §X"、"确认"、"同意"、"OK 你写"
   - **不视为授权**的回复:"好的"、"嗯"、"知道了"、"明白"、"可以"、"行"——这些是承接性回应,不是写入授权
   - 用户沉默、转移话题、给出新任务,均**不视为授权**

只有走完 **STOP → PROPOSE → WAIT → 收到明确授权** 这个完整链路,才允许动手编辑 agent.md。

### 0.3 禁止的行为(零容忍)

以下行为**任何情况下都不允许**,即使 Agent 自认为是"善意补充":

- ❌ 在完成其他任务时"顺手"把这次的改动写入 agent.md
- ❌ 把"显而易见的常识"或"行业最佳实践"自行写入
- ❌ 把已经体现在代码/配置/CI 中的事实再"写一份到 agent.md"作为备份
- ❌ 在用户没有明确说"写入"时,用 `SearchReplace` / `Write` / `Edit` 修改 agent.md
- ❌ 把未经用户确认的规范以"草案"、"建议条目"、"占位"等形式写入 §11 或任何章节
- ❌ 修改 §0 本节(除非用户明确同意修改本节)
- ❌ 把 agent.md 里**已经存在**的条款"美化"、"重构"、"合并"、"扩写"——这也算修改,同样需要 STOP → PROPOSE → WAIT
- ❌ 用 `agent.md` 以外的文件(如 README、CHANGELOG)记录"建议未来加入 agent.md 的规范"作为变相绕过

### 0.4 §11 待补充区的特殊约束

§11 是经用户确认后规范的**唯一沉淀位置**,有以下额外约束:

- 每条记录必须严格采用以下格式,缺字段视为格式错误:

  ```
  ### YYYY-MM-DD · 标题
  - 背景:...
  - 规范:...
  - 影响范围:...
  ```

- 标题应**精炼且可索引**,不超过 30 字。
- "规范"字段应**可执行、可验证**,不写"应该尽量"、"建议考虑"这种模糊表述。
- "影响范围"应明确列出影响的目录、文件类型、流程或角色。
- 记录一旦写入,Agent **不得**自行修改、删除、重排序;此类操作同样需要走 0.2 流程。
- 若用户拒绝某条提议,**不得**保留为"暂缓"、"备选"、"待定"——直接丢弃,不留痕迹。

### 0.5 当 Agent 不确定时的默认动作

当 Agent 对某条规范是否需要写入产生哪怕**一丝**犹豫时,默认动作永远是:**不写,先问**。

> 宁可多问一次显得啰嗦,也不要静默写入造成规则污染。

### 0.6 历史欠账的处理

如果发现 agent.md 中已经存在**未经用户确认**就被写入的历史条目:

1. **不要**自行删除或修改。
2. 在下一次互动时主动告知用户:"§X 中的 Y 条目是我之前未经确认就写入的,是否需要保留?"
3. 根据用户答复处理。

> 这一节本身就是 0.6 的执行结果——历史上 Agent 自行写入了几条,现已全部清除并重写本机制。

---

## 1. 技术栈与基础约束

- 框架:Vue 3 `<script setup lang="ts">` + Composition API,**禁止** Options API。
- 状态:Pinia,使用 `defineStore` 的 setup 写法(返回 ref/computed/函数)。
- 语言:TypeScript 严格模式,**不允许** `any`,需要时用 `unknown` + 类型守卫。
- 构建:Vite,`base: './'` 保持相对路径输出。
- 包管理:**pnpm**(项目锁文件为 `pnpm-lock.yaml`)。
- 样式:SCSS + 大量 CSS 变量;**禁止**引入 Tailwind、UnoCSS、CSS-in-JS。
- 图标:统一使用 `@lucide/vue`,不混用其他图标库。
- 依赖原则:**能用浏览器原生 API 就不引入依赖**;新增依赖必须先与用户确认。
- 测试:vitest + jsdom,测试文件放 `src/tests/*.test.ts`。
- 提交前必须能通过:`pnpm test`、`pnpm type-check`、`pnpm lint`、`pnpm format:check`、`pnpm build`。
- 环境备注:开发主机为 Windows,命令示例统一使用 **PowerShell**。

---

## 2. 目录与分层

严格保持以下分层,**禁止**跨层倒置依赖:

```
入口      src/main.ts → src/App.vue
状态      src/stores/         Pinia store
编排      src/App.vue         只装配,不写业务
能力      src/composables/    业务 hook(命名 useXxx)
服务      src/services/       远程/外部 IO 抽象
工具      src/utils/          纯函数 + 数据结构
组件      src/components/     视图组件
配置/类型 src/config/, src/types/
样式      src/styles/         全局样式
PWA       public/sw.js, public/manifest.webmanifest
脚本      scripts/            构建期 node 脚本
```

依赖方向:`components / App.vue → composables → services / stores → utils / types`。

- `utils` **不得** import composables / services / stores / components。
- `services` **不得** import composables / components。
- `composables` 之间可互相组合,但避免循环依赖。
- `stores` 只描述真状态,**不**承担业务流程编排。

---

## 3. 代码风格

### 3.1 通用约定

- 缩进 2 空格,使用单引号,**不写**分号(遵循现有源文件风格)。
- 文件末尾保留一个空行。
- 命名:
  - 文件:Vue 组件 `PascalCase.vue`,composable `useXxx.ts`,工具 `kebab-case.ts` 或 `camelCase.ts`(沿用既有命名)。
  - 常量:`SCREAMING_SNAKE_CASE`,优先放在文件顶部或独立 `const` 模块。
  - 类型/接口:`PascalCase`,接口不加 `I` 前缀。
  - 函数:动词开头(`load`、`apply`、`schedule`、`predict`...)。
- **禁止** `console.log` 进入主干代码;调试用 `console.warn`/`console.error` 且必须有意义。
- **禁止**在源码里写注释,除非用户明确要求,或代码确实存在反直觉的浏览器限制需要警示(如 WebAudio attach once)。
- ESLint 报警必须修复,不允许 `// eslint-disable-next-line` 滥用。

### 3.2 TypeScript

- 公共数据结构定义在 `src/types/`。
- 函数参数和返回值类型显式标注(简单局部变量除外)。
- 使用 `as const`、字面量联合、可辨识联合(`status: 'idle' | 'ready' | 'empty' | 'error'`)替代魔法字符串。
- 异步函数返回类型显式写明 `Promise<T>`。

### 3.3 Vue 组件

- 一律 `<script setup lang="ts">`。
- 顺序:`<script setup>` → `<template>` → `<style scoped lang="scss">`。
- Props/Emits 使用 `defineProps<...>()` / `defineEmits<...>()` 的**类型签名**形式,不用运行时对象写法。
- 复杂组件可通过 `variant` prop 复用同一组件渲染多形态(参考 `PlayerControls.vue` 的 `bar | page | progress | mini`)。
- 事件回调优先用 prop 注入函数(`onToggle`、`onSeek`),保持解耦;只有真正需要冒泡的事件才用 `emit`。
- `<style>` 默认 `scoped`;全局样式集中在 `src/styles/global.scss`。

### 3.4 Composable

- 单一职责,文件名即语义(`useAudioPlayer`、`useThemeAccent`、`useSleepTimer`...)。
- 对外只暴露**最小契约**:`ref`/`computed`/函数;内部状态用闭包封装。
- 接收响应式输入时统一用 `Ref<T>` 或 `ComputedRef<T>`,而非裸值。
- 副作用必须在 `onBeforeUnmount` 中完整清理:事件监听集中放入 `listeners: Array<() => void>` 一次性 detach。
- 所有 `setTimeout / setInterval / requestAnimationFrame` 必须保存句柄并在卸载时清理。
- 涉及 DOM/BOM 的 API 访问前先做能力检测(`typeof window !== 'undefined'`、`'mediaSession' in navigator` 等)。

### 3.5 Store(Pinia)

- 使用 setup 风格 `defineStore('xxx', () => {...})`。
- 字段分组:核心数据 → UI 镜像 → 设置 → 操作函数。
- 设置类字段持久化必须经过 `safeStorage`,并使用 **debounce(≥150ms)** 的深度 watch。
- 任何持久化结构都要有 `xxxVersion` 字段,并提供 `migrateXxx` 浅合并默认值,保证向前迁移。
- 队列/集合变化用 `xxxVersion` bump 触发下游 watcher,避免对引用做深比较。

### 3.6 Service

- 所有外部 IO **必须**:
  - 接受可选 `signal?: AbortSignal`;
  - 自带超时(默认 8s),内部用 `AbortController` 实现,`finally` 清理 timer;
  - 用 `try/catch` 包裹,失败时返回结构化结果或抛出可识别错误,**绝不**让未处理的 reject 冒泡。
- 并行请求统一用 `Promise.allSettled`,单源失败不影响其他源。
- 远程返回的数据先经过 `utils/` 中的 adapter(`mapXxx`)归一化,再进入 store。
- 可缓存的远程结果走 LRU(参考 `services/lyrics.ts`),失败时主动 `delete` 防止毒化缓存。

### 3.7 Utils

- 必须是**纯函数**或纯数据结构,无副作用,无 IO,无 DOM 依赖(除非工具本身就是 DOM 工具,如 `utils/dom.ts`)。
- 覆盖到的算法/解析逻辑需补 vitest 单测。

---

## 4. 设计风格(UI / UX)

### 4.1 视听一体

- UI 应跟随音乐"呼吸":通过 CSS 变量(`--beat-level`、`--accent`、`--accent-rgb`、`--accent-soft`、`--background-blur`、`--background-saturation`、`--beat-brightness`)在根容器统一注入,样式层通过变量消费,**避免**在 JS 中频繁直接操作 style 属性。
- 主题色由封面图采样决定,过渡用 720ms cubic-out 在 RGB 三通道插值平滑切换,严禁硬切。
- 节拍/能量类计算必须支持 `prefers-reduced-motion` 早退。

### 4.2 过渡与动效

- 缓动统一使用 `cubic-bezier(.16, 1, .3, 1)` 系列或等价 cubic-out;不使用线性过渡作为主交互。
- 命名过渡(`<Transition name="xxx">`)集中放在组件局部样式或 `global.scss`,命名采用 `domain-action` 形式(`artwork-bg-swap`、`lyrics-panel-swap`、`settings-drop`)。
- 列表/抽屉/弹层进出场必须有动画,且持续时间在 180~420ms 之间;超过 600ms 仅用于"沉浸式"场景(如歌词牵引、主题色过渡)。
- 长列表滚动到目标行优先采用 **FLIP** 技巧(参考 `LyricsPanel.scrollToIndex`)。

### 4.3 响应式三态

- 至少覆盖:**宽屏(≥1080px)**、**平板(720~1079px)**、**移动(≤720px)**。
- 移动端必须:
  - 适配 `safe-area-inset-*`;
  - 使用 `visualViewport` 监听键盘/工具栏变化;
  - 提供 mobile 专属布局而不是单纯缩放。
- 不写固定像素布局,优先用 `clamp()`、`min()`、`max()`、`vh/vw/dvh/svh` 和 `aspect-ratio`。

### 4.4 无障碍(A11y)

- 所有交互元素必须有 `aria-label` 或可见文字 + `title`。
- 抽屉/弹层使用 focus trap,Esc 关闭并把焦点还原到 trigger。
- 完整支持 `prefers-reduced-motion` 与 `prefers-contrast: more`。
- 不依赖颜色单独传达状态(颜色 + 图标/文字双重提示)。
- 键盘可达:核心操作(播放、上下曲、进度、关键面板)都有快捷键且在 `input/contenteditable` 中自动让出。

### 4.5 反馈

- 移动端触感反馈(`navigator.vibrate`)只在确认是手机时调用;**禁止**在桌面端触发。
- 错误/提示走统一 toast 通道,文案中文化、口语化,不暴露技术细节。
- 长任务前必须有 loading/skeleton 状态,不允许界面"空白等待"。

### 4.6 视觉细节

- 优先磨砂玻璃(`backdrop-filter`)+ mask-image 渐隐 + 大圆角。
- 颜色不写死十六进制,统一通过 `--accent` 等 CSS 变量推导。
- 暗色为默认基调(沿用 `#151318` 系列底色),浅色场景需独立适配方案再讨论。

---

## 5. 性能与工程兜底

- **fetch**:统一带超时(8s 默认)、AbortController、try/catch;允许时走 `Promise.allSettled` 并行。
- **缓存**:重复读取的远程资源使用 `utils/lru-cache.ts`(默认容量 64),命中标志需区分"in-flight Promise"与"已完成结果"。
- **图片**:大图加载前优先 `Image.decode()`,失败再 fallback。
- **长列表**:超过 ~80 条时使用虚拟列表(参考 `TrackList.vue`),`ITEM_HEIGHT` + `BUFFER_COUNT`。
- **共享状态**:跨组件的轻量缓存优先用**模块级 `shallowRef`** 形成单例(参考 `useCoverCache`),避免每个组件重新订阅。
- **存储**:**禁止**直接调用 `localStorage`,必须经过 `utils/storage.ts` 的 `safeStorage`。
- **音视频**:涉及 `<audio>`/`<video>` 时,优先复用元素而非销毁重建;若挂接 WebAudio,务必记录"`createMediaElementSource` 只能 attach 一次"的约束。
- **预加载**:可预测的下一步资源应提前并行预热(音频 / 封面 / 文本),并设置 race timeout(≥6s)防止挂死。
- **防抖/节流**:UI 同步状态用 `requestAnimationFrame`;持久化与高频写入用 ≥150ms debounce。
- **监听器**:集中存入数组并在卸载/切换时一次性 detach,**严禁**遗留事件监听导致泄漏。

---

## 6. PWA / Service Worker 规则

- `public/sw.js` 必须遵循以下放行原则:
  - 带 `Range` 头的请求:**直接 fallthrough**,不得缓存(否则破坏 206 分段响应、seek 失效)。
  - `destination === 'audio' | 'video'`:**直接 fallthrough**。
  - 导航请求(HTML):network-first,失败回落到缓存的 SPA 入口。
  - 其他同源 GET:cache-first + 后台更新。
  - 跨域请求:直接放行。
- 缓存名称通过 `__SW_CACHE_NAME__` 占位符,由 `scripts/inject-sw-cache-name.mjs` 在 `postbuild` 阶段注入 `xxx-v{version}`,确保版本更新自动驱逐旧缓存。
- 新增需要离线可用的资源时,加入 `install` 阶段的 precache 列表;无关大资源**禁止**放入 precache。
- `activate` 阶段清理所有非当前 CACHE_NAME 的缓存,并 `clients.claim()`。
- Service Worker **仅在 PROD** 注册(`import.meta.env.PROD`),开发环境保持热更。

---

## 7. 错误处理与降级

- 任何可能失败的操作必须**优雅降级**,不允许整页崩溃:
  - Web Share → Clipboard API → `execCommand('copy')` 三级降级;
  - Document Picture-in-Picture → `window.open(popup)`;
  - Fullscreen API 不可用 → 文案提示用户使用 F11;
  - 浏览器存储不可用 → safeStorage 静默 try/catch。
- 用户可见错误必须**中文友好文案**;原始 `DOMException`/`MediaError` 需通过映射函数翻译。
- 失败资源(曲目、封面、歌词)记录在 Set 中,后续可启用"自动跳过 / 自动占位"策略,避免反复失败。

---

## 8. 测试规范

- 工具函数、解析器(LRC、tracks 归一化等)、缓存结构、服务层超时与降级:**必须**有单测。
- 组件层只测交互边界(快捷键、focus trap、虚拟列表切片)。
- 使用 `vitest run` 验证;新增公共能力时一并提交对应 `*.test.ts`。
- 测试文件命名与被测对象一致:`lru-cache.ts` ↔ `lru-cache.test.ts`。

---

## 9. 提交与变更原则

- 改动遵循用户全局规则:
  - **不需要**保持向后兼容,但必要的相关改动**必须**一并完成;
  - **不**做最小修复;遇到 bug **完整修复**根因;
  - 输出代码时**不省略**逻辑,直接给出完整可运行的代码。
- 不主动 `git commit`,除非用户明确要求。
- **禁止**主动创建 README、设计文档等说明性 markdown 文件,除非用户要求。
- 优先 **编辑** 现有文件而非新建。
- 任何会影响构建/部署/SW 缓存策略的修改,需在响应中显式提醒用户。
- **提交规范**:
  - 必须遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范。
  - 提交信息格式:`<type>(<scope>): <subject>`。
  - 支持的 type: `build`、`chore`、`ci`、`docs`、`feat`、`fix`、`perf`、`refactor`、`revert`、`style`、`test`。
  - scope 必填,使用小写。
  - 标题不超过 100 字符,末尾不加句号。
  - body 和 footer 可选,每行不超过 100 字符。
- **Git Hooks**:
  - `pre-commit`: 自动运行 `lint-staged`,对暂存文件执行 `pnpm lint`、`pnpm type-check`、`pnpm format`。
  - `commit-msg`: 自动运行 `commitlint`,校验提交信息格式。
  - 如需跳过 hook(不推荐):`git commit --no-verify`。
- **PR 流程**:
  - 必须从 fork 的仓库提交 PR,目标分支为 `main`。
  - PR 必须通过 CI 验证(测试、类型检查、lint、构建)。
  - PR 模板必填项:描述、相关 Issue、改动类型、测试情况。
  - 代码审查通过后由维护者合并。
- **部署平台规范**:
  - 支持 4 个部署平台:Vercel(`vercel.json`)、Cloudflare Pages(`wrangler.toml`)、Netlify(`netlify.toml`)、GitHub Pages(`.github/workflows/deploy-pages.yml`)。
  - 所有平台配置必须统一:构建命令 `pnpm build`、输出目录 `dist`、Node 22、pnpm 11。
  - **安全头一致性**:所有平台的 headers 配置必须保持一致(CSP、X-Content-Type-Options、X-Frame-Options、Referrer-Policy、Permissions-Policy)。
  - **SPA Fallback**:所有平台必须配置 `/* -> /index.html` 的 200 重写,确保路由刷新有效。
  - **Service Worker 缓存控制**:`/sw.js` 必须配置 `Cache-Control: public, max-age=0, must-revalidate` + `Service-Worker-Allowed: /`,禁止浏览器长期缓存 SW。
  - **静态资源缓存**:`/assets/*` 配置 `max-age=31536000, immutable`(Vite 已 hash 文件名)。
  - 新增或修改平台配置时,**必须同步更新所有已支持平台的对应配置**。

---

## 10. 命令速查(PowerShell)

```powershell
pnpm install
pnpm dev
pnpm test
pnpm type-check
pnpm lint
pnpm format
pnpm format:check
pnpm build
pnpm preview
```

---

## 11. 待补充区(由 Agent 与用户共同维护)

> 本节用于沉淀后续协作中**经用户确认**的新规范。每条记录格式如下:
>
> ```
> ### YYYY-MM-DD · 标题
> - 背景:...
> - 规范:...
> - 影响范围:...
> ```
>
> Agent 提议但**未获用户确认**的规范不得写入此处。

> 当前为空。所有新增规范必须经过 §0.2 流程后由用户**明确**指示写入。

### 2026-06-17 · 推送与发版的强制确认机制

- 背景:历史上 Agent 在用户未明确指示推送的情况下自行 git push,
  且发版时未在干净仓库状态验证 CI 链路就推 tag,导致 v0.1.0 在
  GitHub Actions 失败。这是严重的工程纪律问题。
- 规范:
  1. **未获用户明确指示,严禁推送任何 git 内容**(commit / tag / branch)。
     - 允许的"推送指令"用词:"推送"、"上传"、"push"、"发版"、
       "上传一下"、"推到 GitHub" 等。
     - **不视为推送指令**:"提交一下"、"做个 commit"、"先存一下"、
       "保存"、"加进去"、"OK"、"好的" 等承接性回应。
     - 用户没有提及推送的话,Agent 完成本地 commit 后必须**停下**,
       明确告诉用户"已完成本地提交,是否推送?",**等用户明确同意**。
  2. **任何 release / tag 推送前,必须在干净仓库状态下验证 CI 链路**:
     - 删除所有 gitignored 的生成产物(`src/generated/`、`dist/`、
       `coverage/`、`node_modules` 视情况)
     - 跑完整 CI 命令链:
       `pnpm format:check && pnpm test && pnpm type-check && pnpm lint && pnpm build`
     - 全绿才允许 commit + tag + push
     - "本地之前 build 过留下的产物" **不算**验证依据,必须在删除后
       重新跑一遍才算
  3. **推送中途遇到任何"看似无关"的失败**(如网络抖动、tag 冲突、
     格式警告),都必须向用户报告状态,**不得自行决断**继续推或撤销。
  4. **强制推送 / 删除远程引用**(`push --force` / 删除 tag / 删除分支)
     必须明示用户原因,获得明确同意后才能操作,且优先使用
     `--force-with-lease` 而不是 `--force`。
- 影响范围:所有 git push / git tag / GitHub 远程操作流程。
