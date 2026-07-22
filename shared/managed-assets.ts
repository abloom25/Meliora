import type { MusicConfig } from '../src/types/music'

const MANAGED_MUSIC_PREFIX = './music/'
const MANAGED_ICON_PATTERN = /^\.\/icon\.(?:png|jpe?g|webp|ico)$/i

/**
 * 将公开配置中的受管静态资源 URL 转换为仓库路径。
 *
 * 只识别管理后台能够上传的两类路径；远程 URL、data URL 和其他公开文件
 * 都不属于后台文件事务，不能被配置保存流程自动删除。
 */
export function managedAssetRepositoryPath(value: string | undefined): string | null {
  const normalized = value?.trim()
  if (!normalized) return null

  if (normalized.startsWith(MANAGED_MUSIC_PREFIX) || MANAGED_ICON_PATTERN.test(normalized)) {
    const repoPath = `public/${normalized.slice(2)}`
    // 与 upload-handler 的 isAllowedUploadPath 同一安全标准:配置值最终会成为
    // GitHub tree 的删除条目(sha:null),必须拒绝穿越段,防止已认证会话借
    // 配置保存流程删除白名单外的仓库文件。
    if (
      repoPath.includes('\0') ||
      repoPath.includes('\\') ||
      repoPath.split('/').some((seg) => seg === '..' || seg === '.')
    ) {
      return null
    }
    return repoPath
  }
  return null
}

/** 收集一份配置当前引用的全部后台受管文件。 */
export function collectManagedAssetPaths(config: MusicConfig): Set<string> {
  const paths = new Set<string>()
  const add = (value: string | undefined) => {
    const path = managedAssetRepositoryPath(value)
    if (path) paths.add(path)
  }

  add(config.siteIcon)
  for (const track of config.localTracks) {
    add(track.audio)
    add(track.cover)
    add(track.lyrics)
  }
  return paths
}
