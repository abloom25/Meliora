# Meliora

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fabloom25%2FMeliora)

基于 Vue 3、TypeScript、Pinia 和 SCSS 的沉浸式单页音乐播放器。所有远程歌单和本地音乐会合并为一个匿名曲库，页面不会显示歌单名称、平台或来源。

## 开发

```powershell
pnpm install
pnpm dev
```

质量检查：

```powershell
pnpm test
pnpm type-check
pnpm lint
pnpm build
```

## 配置远程歌单

编辑 `src/config/music.ts`：

```ts
export const musicConfig: MusicConfig = {
  siteName: 'Meliora',
  apiEndpoint: 'https://api.music.abloom.site/api',
  playlists: [
    {
      server: 'netease',
      playlistId: '17390341309',
      enabled: true,
    },
    {
      server: 'tencent',
      playlistId: '另一个歌单 ID',
      enabled: true,
    },
  ],
  localTracks: [],
}
```

支持 `netease` 和 `tencent`。多个歌单会按配置顺序合并，重复歌曲按规范化后的“歌名 + 歌手”去重。

## 配置本地音乐

将文件放入 `public`，例如：

```text
public/
  music/example.mp3
  covers/example.jpg
  lyrics/example.lrc
```

然后添加配置：

```ts
localTracks: [
  {
    id: 'example',
    title: 'Example Song',
    artist: 'Example Artist',
    album: 'Example Album',
    audio: '/music/example.mp3',
    cover: '/covers/example.jpg',
    lyrics: '/lyrics/example.lrc',
  },
],
```

`audio` 必填，封面、专辑和歌词可选。歌词支持标准 LRC 时间标签以及 `[00:00.00-1]` 这类带序号的扩展标签；纯文本歌词也可展示，但不能按时间跳转。

只有制作信息和“纯音乐，请欣赏”等占位内容时，播放器会自动隐藏歌词并居中显示歌曲信息。右上角歌词按钮可以随时开关可用歌词。

## 构建

```powershell
pnpm build
pnpm preview
```

构建结果位于 `dist`，可以部署到任意静态站点服务。

## GitHub Pages 自动部署

仓库已经包含 `.github/workflows/deploy-pages.yml`。推送到 `main` 后，GitHub Actions 会依次执行测试、类型检查、lint 和构建，通过后发布到 GitHub Pages。

首次使用时，在 GitHub 仓库中打开 `Settings > Pages`，将 `Source` 设置为 `GitHub Actions`。之后每次推送到 `main` 都会自动更新站点，也可以在 Actions 页面手动运行工作流。

Vite 使用相对资源路径，因此普通项目仓库和 `username.github.io` 仓库都可以直接部署。

## Vercel 自动部署

点击顶部的 `Deploy with Vercel` 按钮即可一键克隆并部署到自己的 Vercel 账号。

仓库已经包含 `vercel.json`。在 Vercel 中选择 `Add New > Project` 并导入此 GitHub 仓库，无需修改构建参数：

```text
Install Command: pnpm install --frozen-lockfile
Build Command: pnpm build
Output Directory: dist
```

Vercel 与 GitHub 连接后，推送到生产分支会自动生产部署，其他分支和 Pull Request 会自动生成 Preview Deployment。
