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
- 构建:Vite,`base: '/'` 保持根路径输出。
- 包管理:**pnpm**(项目锁文件为 `pnpm-lock.yaml`)。
- 运行环境:`engines.node >= 22`、`engines.pnpm >= 11.5.3`(`package.json` 已声明);`packageManager` 锁定为 `pnpm@11.5.3`,所有部署平台 / CI 同步使用 **Node 22 + pnpm 11.5.3+**。
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
入口      src/main.ts → src/App.vue → src/views/PlayerView.vue
状态      src/stores/         Pinia store
编排      src/App.vue         只装配,不写业务
能力      src/composables/    业务 hook(命名 useXxx)
服务      src/services/       远程/外部 IO 抽象
工具      src/utils/          纯函数 + 数据结构(部分需保持 DOM-free 以便供 worker 共用,详见 §3.7)
组件      src/components/     视图组件
Worker    src/workers/        Web Worker 入口(`*.worker.ts`),仅依赖 `src/utils/` 中的纯模块
配置/类型 src/config/, src/types/
样式      src/styles/         全局样式
PWA       public/sw.js, public/manifest.webmanifest
脚本      scripts/            构建期 node 脚本
```

依赖方向:`views / components → composables → services / stores → utils / types`;Worker 入口仅允许 `import` `src/utils/` 中标记为 DOM-free 的纯模块。

- `utils` **不得** import composables / services / stores / components。
- `services` **不得** import composables / components。
- `composables` 之间可互相组合,但避免循环依赖。
- `stores` 只描述真状态,**不**承担业务流程编排。
- `workers` 中的代码运行在 Worker 上下文,**不得** import 任何 DOM/BOM API、Vue 模块、composable、store、service;只能 import `src/utils/` 中的 DOM-free 纯模块。

---

## 3. 代码风格

### 3.1 通用约定

- 缩进 2 空格,使用单引号,**不写**分号(prettier 配置 `semi: false`,沿用现有源文件风格)。
- 文件末尾保留一个空行。
- 命名:
  - 文件:Vue 组件 `PascalCase.vue`,composable `useXxx.ts`,工具 `kebab-case.ts` 或 `camelCase.ts`(沿用既有命名)。
  - 常量:`SCREAMING_SNAKE_CASE`,优先放在文件顶部或独立 `const` 模块。
  - 类型/接口:`PascalCase`,接口不加 `I` 前缀。
  - 函数:动词开头(`load`、`apply`、`schedule`、`predict`...)。
- **禁止** `console.log` 进入主干代码;调试用 `console.warn`/`console.error` 且必须有意义。
- 在源码里写注释,特别是确实存在反直觉的浏览器限制需要警示(如 WebAudio attach once)。
- ESLint 报警必须修复,不允许 `// eslint-disable-next-line` 滥用。
- **模板内联事件禁止多语句**:`@click="a(); b()"` 会被 Prettier 拆成多行并移除分号,导致 Vue 模板编译器报 `Unexpected token, expected ","`。必须改用方法引用(`@click="handler"`)或包装函数(`@click="wrapper(arg)"`,wrapper 内部依次调用 a、b)。slot prop 回调同理(如 Dropdown 的 `close` 需与业务逻辑组合时,写成 `@click="selectServerAndClose(opt.value, close)"`)。

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

### 3.3.1 共享组件库(`src/components/`)

管理后台与播放器共用的基础 UI 组件统一放在 `src/components/`,各业务组件**必须**复用,**禁止**在业务文件中重复实现以下能力的结构与样式:

| 组件           | 用途     | 关键约束                                                                                                                                                                                                                    |
| -------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConfirmModal` | 确认弹窗 | 内部 `<Teleport to="body">` + `<Transition>`;props: `visible`/`title`/`cancelText`/`confirmText`/`danger`/`loading`/`width`;slots: `default`(正文)/`header`                                                                 |
| `ToggleSwitch` | 开关     | `v-model`;内部渲染自身 `<label>`,调用方外层**必须**用 `<div>` 而非 `<label>`(HTML 不允许 label 嵌套)                                                                                                                        |
| `SettingRange` | 设置滑块 | `v-model`(number);自绘 `role="slider"`,**禁止**用原生 `<input type="range">`;内部自动计算 `--setting-progress`,调用方**无需**传 `:style` 进度变量;拖动时填充宽度不做动画,填充条右侧保持直角;需要提交语义时监听 `@change`    |
| `Toast`        | 通知     | `<Teleport to="body">`;props: `message`/`type`/`position`;emit: `dismiss`                                                                                                                                                   |
| `Dropdown`     | 下拉菜单 | 封装 outside-click + open/close;scoped slots: `#trigger({ toggle })` / `default({ close })`                                                                                                                                 |
| `Collapse`     | 折叠展开 | `v-model:expanded`;`grid-template-rows: 0fr→1fr` 动画内聚;`#trigger({ toggle })` + 默认 slot;箭头统一用单 `ChevronDown` + `:class="{ collapsed }"` + `rotate(-90deg)`,**禁止**用 `ChevronUp`/`ChevronDown` 动态切换         |
| `BaseInput`    | 输入框   | `inheritAttrs: false` + `v-bind="$attrs"` 透传 `type`/`placeholder`/`class`/`@blur`/`@keydown` 等;自带 `max-width: 320px`;`:value`+`@input` 模式须改为 `:model-value`+`@update:model-value`(handler 直接收 string,非 Event) |
| `BaseTextarea` | 文本域   | 同 `BaseInput` 模式;自带 monospace + `min-height: 180px`                                                                                                                                                                    |

规范:

- 新增基础 UI 能力时,优先扩展共享组件,而非在业务文件中复制粘贴结构与样式。
- 接入共享组件后,**必须**同步删除业务文件中废弃的 scoped 样式块(如 `.modal-backdrop`、`.toggle-row input + i`、`.row-input`、`.analytics-collapse` 等),避免留下死样式。
- 共享组件根元素样式用 `scoped`;当调用方需要穿透到组件内部元素(如 `BaseInput` 的 `.invalid` 状态)时,用 `:deep(.base-input.invalid)` 规则。
- `max-width` 例外:组合容器(如带按钮的输入组 `.token-field`、`.icon-input-group`)需要输入框填满剩余空间时,用 `:deep(.base-input) { max-width: none }` 覆盖。
- 所有设置类滑块(播放器设置、管理后台设置、均衡器、定时关闭等)必须复用 `SettingRange`;若业务需要特殊布局,只能通过外层 class 调整尺寸/间距,不得在业务组件中重新实现 range 轨道、thumb 或浏览器伪元素样式。
- 触控屏上的滑块命中区域必须大于视觉轨道:使用 `@media (pointer: coarse)` 扩大外层 slider 高度/点击区域,但保持内部轨道视觉高度不变。不要为了触控可用性直接加粗视觉轨道。

### 3.4 Composable

- 单一职责,文件名即语义(`useAudioPlayer`、`useThemeAccent`、`useSleepTimer`...)。
- 对外只暴露**最小契约**:`ref`/`computed`/函数;内部状态用闭包封装。
- 接收响应式输入时统一用 `Ref<T>` 或 `ComputedRef<T>`,而非裸值。
- 副作用必须在 `onBeforeUnmount` 中完整清理:事件监听集中放入 `listeners: Array<() => void>` 一次性 detach。
- 所有 `setTimeout / setInterval / requestAnimationFrame` 必须保存句柄并在卸载时清理。
- 涉及 DOM/BOM 的 API 访问前先做能力检测(`typeof window !== 'undefined'`、`'mediaSession' in navigator` 等)。
- **高频 DOM 直写接口**:涉及每帧/亚秒级写入 DOM 属性或 CSS 变量的 composable,应通过 `getXxxTargets?: () => readonly (HTMLElement | null | undefined)[]` 形式接收宿主提供的目标节点,而不是自己持有 ref。这样能让宿主决定写入范围,避免污染根元素 `:style`(参考 `useBeatAnalyser` 的 `getBeatTargets`)。

### 3.5 Store(Pinia)

- 使用 setup 风格 `defineStore('xxx', () => {...})`。
- 字段分组:核心数据 → UI 镜像 → 设置 → 操作函数。
- 设置类字段持久化必须经过 `safeStorage`,并使用 **debounce(≥150ms)** 的深度 watch。
- 任何持久化结构都要有 `xxxVersion` 字段,并提供 `migrateXxx` 浅合并默认值,保证向前迁移。
- 队列/集合变化用 `xxxVersion` bump 触发下游 watcher,避免对引用做深比较。

### 3.6 Service

- 所有外部 IO **必须**:
  - 接受可选 `signal?: AbortSignal`;
  - 自带超时(**远程 IO 默认 8s**),内部用 `AbortController` 实现,`finally` 清理 timer;
  - 用 `try/catch` 包裹,失败时返回结构化结果或抛出可识别错误,**绝不**让未处理的 reject 冒泡。
- 并行请求统一用 `Promise.allSettled`,单源失败不影响其他源。
- 远程返回的数据先经过 `utils/` 中的 adapter(`mapXxx`)归一化,再进入 store。
- 可缓存的远程结果走 LRU(参考 `services/lyrics.ts`),失败时主动 `delete` 防止毒化缓存。

### 3.7 Utils

- 必须是**纯函数**或纯数据结构,无副作用,无 IO,无 DOM 依赖(除非工具本身就是 DOM 工具,如 `utils/dom.ts`)。
- 覆盖到的算法/解析逻辑需补 vitest 单测。
- **DOM-free 共享纯模块**:任何会被 `src/workers/` 中 Worker 入口 import 的纯模块(例如 `utils/theme-core.ts`)**必须**保持完全 DOM-free——
  - 不得使用 `document` / `window` / `Image` / `HTMLCanvasElement` / `OffscreenCanvas` 等 DOM/BOM API;
  - 也不得 import `utils/dom.ts` 等含 DOM 引用的模块;
  - 输入参数应使用平台中立的数据形态(`Uint8ClampedArray`、`Uint8Array`、纯对象等),由调用方在主线程或 Worker 中分别完成像素采样/解码后再传入。
  - 形如"主线程版"包装文件(`utils/theme.ts`)负责接住 DOM 输入并选择 Worker 路径或主线程兜底,纯算法仅放在 `*-core.ts` 中。

---

## 4. 设计风格(UI / UX)

### 4.1 视听一体

- UI 应跟随音乐"呼吸":通过 CSS 变量(`--beat-level`、`--accent`、`--accent-rgb`、`--accent-soft`、`--background-blur`、`--background-saturation`、`--beat-brightness`)在根容器统一注入,样式层通过变量消费。
- **CSS 变量写入路径分两类,严格区分**:
  - **低频/语义类变量**(如 `--accent`、`--accent-soft`、`--background-blur`):在根容器以 `:style` 对象绑定 / `applyTheme()` 注入,允许走 Vue reactivity。
  - **高频/动画类变量**(如 `--beat-level`,每帧 60Hz 写入):**必须**通过 `useBeatAnalyser` 的 `getBeatTargets` 接口在 RAF 中直接 `el.style.setProperty(...)` 到目标节点,**严禁**让其经过根 `:style` 或 computed,否则会触发整树 style recalc 风暴。变量去重(`lastValue` 比较)与 `isConnected` 守卫是必须的。
- 主题色由封面图采样决定,过渡用 720ms cubic-out 在 RGB 三通道插值平滑切换,严禁硬切。
- 节拍/能量类计算必须支持 `prefers-reduced-motion` 早退。

### 4.2 过渡与动效

- 缓动统一使用 `cubic-bezier(.16, 1, .3, 1)` 系列或等价 cubic-out;不使用线性过渡作为主交互。
- 命名过渡(`<Transition name="xxx">`)集中放在组件局部样式或 `global.scss`,命名采用 `domain-action` 形式(`artwork-bg-swap`、`lyrics-panel-swap`、`settings-drop`)。
- 列表/抽屉/弹层进出场必须有动画,且持续时间在 180~420ms 之间;超过 600ms 仅用于"沉浸式"场景(如歌词牵引、主题色过渡)。
- 长列表滚动到目标行优先采用 **FLIP** 技巧(参考 `LyricsPanel.scrollToIndex`)。
- **路由级切换**必须用 `<router-view v-slot="{ Component }">` + `<Transition mode="out-in">`(参考 `App.vue`),确保路由切换有淡入淡出。
- **同容器多视图互斥切换**(如 `AdminApp.vue` 的 Setup/Login/Dashboard)必须用 `<Transition mode="out-in">` 包裹,`mode="out-in"` 确保旧组件先淡出再淡入新组件,避免布局跳动。
- **浮层(弹窗/通知)**必须先 `<Teleport to="body">` 再 `<Transition>`。**禁止**将 `position: fixed` 的浮层直接放在带 `backdrop-filter` 或 `transform` 的父容器内——这些属性会建立包含块,导致 `fixed` 被困在父容器内变成"全屏"bug。所有 `ConfirmModal`/`Toast` 已内置 Teleport,业务方无需额外处理。

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
- **accent 半透明色派生**:
  - 管理后台(`src/admin/`)下**禁止**使用 `rgba(var(--accent-rgb, fallback), α)`——`--accent-rgb` 仅在播放器主界面由 `useThemeAccent` 通过 JS 运行时设置,admin 页面未定义该变量会永远卡在 fallback 值,导致用户自定义 `--accent` 时选中态/徽章等不跟随变化。
  - admin 下统一用 `color-mix(in srgb, var(--accent), transparent X%)` 从 `--accent` 派生半透明色(`--accent` 已用 `@property` 注册为 `<color>`,`color-mix` 可正确解析)。α→X% 换算:`X% = round((1-α) × 100)`。
  - 播放器主界面(`src/views/PlayerView.vue`)可继续使用 `rgba(var(--accent-rgb), α)`,因为 JS 会设置该变量;但涉及 `calc()` 动态计算 alpha 的场景(如节拍亮度)仍须用 `--accent-rgb`(`color-mix` 不支持动态 alpha 计算)。

---

## 5. 性能与工程兜底

- **fetch**:统一带超时(**远程 IO 8s 默认**)、AbortController、try/catch;允许时走 `Promise.allSettled` 并行。
- **预加载超时**:相邻曲目预加载等本地 / 媒体资源预热超时单独管理(当前 `usePreloadPool` 使用 `PRELOAD_READY_TIMEOUT = 9000`),与 §3.6 的远程 IO 超时区分;新增预加载场景须显式声明并 ≥6s 防止挂死。
- **缓存**:重复读取的远程资源使用 `utils/lru-cache.ts`,各使用方按域独立持有 LRU 实例(当前主题色、歌词、标题各持有一份,容量按域自定,默认 64);命中标志需区分"in-flight Promise"与"已完成结果"。
- **图片**:大图加载前优先 `Image.decode()`,失败再 fallback。
- **长列表**:超过 ~80 条时使用虚拟列表(参考 `TrackList.vue`),`ITEM_HEIGHT` + `BUFFER_COUNT`。
- **共享状态**:跨组件的轻量缓存优先用**模块级 `shallowRef`** 形成单例(参考 `useCoverCache`),避免每个组件重新订阅。
  - **二态语义**:同一 composable 中需要"曲库级持久缓存"与"切歌即重置"两类状态时,**必须分别建模**——前者用模块级 `shallowRef<Set<string>>`(如 `loadedCovers`),后者用模块级 `ref<string | null>`(如 `mainCoverReadyTrackId`),并提供独立的 `markXxx` / `resetXxx` 方法,严禁混用同一变量。
- **存储**:**禁止**直接调用 `localStorage`,必须经过 `utils/storage.ts` 的 `safeStorage`。
- **音视频**:涉及 `<audio>`/`<video>` 时,优先复用元素而非销毁重建;若挂接 WebAudio,务必记录"`createMediaElementSource` 只能 attach 一次"的约束。
- **预加载**:可预测的下一步资源应提前并行预热(音频 / 封面 / 文本),并设置 race timeout(≥6s)防止挂死。预加载封面等占用图像内存的资源时,只对**主预测方向**(下一首)预热,不要对方向 / 反向同时预热。
- **GPU 合成层**:`will-change` **不得**常驻挂在静态规则上,应通过条件 class(如 `.beat-active`)只在动画期间启用;暂停 / 空闲时让浏览器回收合成层。
- **CPU 密集任务**:任何主线程单次执行 >4ms 的图像/像素/解码运算(主题色提取、画布采样等)**必须**走 Web Worker(`src/workers/*.worker.ts`)+ `OffscreenCanvas` + `transferable ImageBitmap`(零复制)的组合,主线程负责 DOM I/O,Worker 负责算力;失败 / 超时(默认 1.5s)必须有主线程同步兜底回退。
- **防抖/节流**:UI 同步状态用 `requestAnimationFrame`;持久化与高频写入用 ≥150ms debounce。
- **监听器**:集中存入数组并在卸载/切换时一次性 detach,**严禁**遗留事件监听导致泄漏。

---

## 6. PWA / Service Worker 规则

- `public/sw.js` 必须遵循以下放行原则:
  - 带 `Range` 头的请求:**直接 fallthrough**,不得缓存(否则破坏 206 分段响应、seek 失效)。
  - `destination === 'audio' | 'video'`:**直接 fallthrough**。
  - 导航请求(HTML):network-first,失败回落到缓存的 SPA 入口。
  - 其他同源 GET:默认 cache-first + 后台更新;后台上传的可变稳定路径资源(如 `/music/`、`/icon.*`)必须直接放行,避免替换文件后仍命中旧缓存。
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
  - 支持 3 个部署平台:Vercel(`vercel.json`)、Cloudflare Pages(`wrangler.toml`)、Netlify(`netlify.toml`)。
  - 所有平台配置必须统一:构建命令 `pnpm build`、输出目录 `dist`;运行时版本遵循 `package.json` 的 `engines` 与各平台配置。
  - **公开站点配置方向**:播放器前端所需的公开配置(站点名称、站点图标、公开歌单、本地曲库、统计与公开自定义样式/脚本等)必须在构建期生成并硬编译进前端,因为后台保存配置本身会写仓库并触发重新部署;不要为了这些公开配置保留首屏必需的 Worker 配置接口。管理后台保存/上传/鉴权/更新等仍通过后端 API 执行,敏感密钥、`apiToken`、管理员数据、GitHub 代理配置不得进入前端 bundle。远程歌单只硬编译 `apiEndpoint` 与歌单 ID 等配置,歌曲列表仍由播放器运行时请求 Meting API,不得预抓取或硬编码 Meting 返回结果。
  - **环境变量(3 必填)**:`GH_TOKEN`(GitHub PAT,Contents Read and write)、`GH_REPO`(`owner/repo` 格式)、`CONFIG_ENCRYPTION_KEY`(配置加密、Cookie 签名、构建期公开配置解密的主密钥,至少 32 位,生产模式校验强度——拒绝全相同字符 / 纯顺序字符等弱模式)。环境就绪提示会校验 `GH_TOKEN` 是否可用、`GH_REPO` 格式与 `CONFIG_ENCRYPTION_KEY` 强度;`GH_TOKEN` 缺失或占位会进入 env-not-ready。`GH_BRANCH` 可选(默认 `main`),`GITHUB_PROXY` 可选且必须是公网 HTTPS URL,`ADMIN_DISABLED` 可选(设为 `true`/`1`/`yes`/`on`,大小写不敏感;禁用管理后台时除状态探针(`GET /api/setup-status`、`GET /api/status-page`,返回 HTML 状态页)外,所有 `/api/*` 返回 403,`/admin` 显示"已禁用")。
    - **不再使用** `ADMIN_PASSWORD` 和 `ADMIN_SECRET`——密码通过 `/setup` 页面首次设置(PBKDF2-SHA256 100k 迭代哈希存入 `public/admin.json`);Cookie 签名密钥与配置加密密钥**均从 `CONFIG_ENCRYPTION_KEY` 派生**(`HMAC-SHA256` / `PBKDF2`),与 `GH_TOKEN` 完全解耦,`GH_TOKEN` 可独立轮换而不影响已加密配置与已签发 Cookie。
    - 开发模式:`DEVELOPMENT=true` 时进入内存模式(配置 / 密码不持久化,加密与签名走明文降级)。
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
pnpm test:watch
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

> 所有新增规范必须经过 §0.2 流程后由用户**明确**指示写入。

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
