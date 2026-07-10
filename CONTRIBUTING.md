# Contributing to Meliora

感谢你愿意为 Meliora 贡献代码！以下是参与本项目的基本规范。

## 行为准则

本项目遵循 [Contributor Covenant](https://www.contributor-covenant.org/) 行为准则。请保持友好、尊重的沟通氛围，禁止任何形式的骚扰、歧视或不礼貌行为。

## 贡献流程

### 1. 查找或创建 Issue

- 在提交 PR 前，请先在 [Issues](https://github.com/abloom25/Meliora/issues) 中查找是否已有相关讨论。
- 如果是新功能或 bug，请先创建 Issue 描述清楚，获得维护者确认后再开始实现。
- 优先处理带有 `good first issue`、`help wanted` 标签的任务。

### 2. Fork 仓库

点击页面右上角的 **Fork** 按钮，将仓库复制到你的 GitHub 账号下。

### 3. 创建分支

```powershell
git clone https://github.com/你的用户名/Meliora.git
cd Meliora
git checkout -b feature/你的功能名
```

分支命名规范：

- 新功能：`feature/xxx`
- Bug 修复：`fix/xxx`
- 文档更新：`docs/xxx`
- 重构：`refactor/xxx`
- 测试：`test/xxx`

### 4. 开发

- 阅读 [agent.md](agent.md) 了解代码风格与设计规范。
- 确保代码通过所有质量检查：

```powershell
pnpm install
pnpm test
pnpm type-check
pnpm lint
pnpm build
```

- 添加或更新测试用例（如有需要）。

### 5. 提交代码

遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```
<type>(<scope>): <subject>

<body>

<footer>
```

**类型说明**：

- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `style`: 代码格式（不影响功能）
- `refactor`: 重构（不新增功能也不修复 bug）
- `perf`: 性能优化
- `test`: 测试相关
- `build`: 构建或依赖更新
- `ci`: CI/CD 配置
- `chore`: 其他杂项
- `revert`: 回滚提交

**示例**：

```
feat(lyrics): 支持逐字滚动歌词

- 实现歌词逐字高亮效果
- 添加歌词滚动速度配置
- 修复歌词对齐问题

Closes #123
```

### 6. 推送分支

```powershell
git push origin feature/你的功能名
```

### 7. 创建 Pull Request

1. 访问 [Meliora 仓库](https://github.com/abloom25/Meliora)
2. 点击 **Compare & pull request**
3. 填写 PR 模板：
   - 描述改动内容
   - 关联相关 Issue
   - 说明测试情况
4. 点击 **Create pull request**

### 8. 代码审查

- 维护者会审查你的代码，请耐心等待反馈。
- 根据审查意见进行修改，修改后再次推送即可自动更新 PR。
- 审查通过后，维护者会合并你的 PR。

## 开发环境

### 必要工具

- Node.js 22+
- pnpm 11.5.3+
- Git

### 常用命令

```powershell
# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev

# 运行测试
pnpm test

# 类型检查
pnpm type-check

# 代码检查
pnpm lint

# 格式化代码
pnpm format

# 构建生产版本
pnpm build
```

## 代码风格

详细规范请参考 [agent.md](agent.md)，以下是关键点：

- 使用 Vue 3 Composition API（`<script setup>`）
- 使用 TypeScript，禁止 `any`
- 使用 SCSS + CSS 变量，禁止 Tailwind
- 组件命名采用 PascalCase
- Composable 命名采用 `useXxx`
- 代码缩进 2 空格，单引号，无分号

## 提交规范

所有提交必须通过以下检查：

1. **Commitlint**：提交信息必须符合 Conventional Commits 规范
2. **lint-staged**：暂存文件必须通过 lint 和 format 检查

如果提交失败，请根据错误信息修复后重新提交。

## 测试规范

- 新增功能必须添加相应的测试用例
- 测试文件放在 `src/tests/` 目录，命名为 `xxx.test.ts`
- 使用 vitest + jsdom 进行测试

## 常见问题

### Q: 如何同步上游仓库的更新？

```powershell
# 添加上游远程仓库
git remote add upstream https://github.com/abloom25/Meliora.git

# 同步更新
git fetch upstream
git checkout main
git merge upstream/main
```

### Q: 提交时遇到 lint-staged 错误？

运行以下命令修复：

```powershell
pnpm lint
pnpm format
```

然后重新提交。

### Q: 如何跳过 pre-commit hook？

不建议跳过，但如果确有必要：

```powershell
git commit --no-verify
```

## 联系我们

如有任何问题，请在 [Issues](https://github.com/abloom25/Meliora/issues) 中提问，或通过 GitHub Discussions 交流。
