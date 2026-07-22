export default {
  // eslint 与 prettier 只处理暂存文件;type-check 必须全仓跑(单文件无法做项目级类型检查)
  '*.{js,ts,vue,mjs,cjs}': ['eslint --fix', () => 'pnpm type-check'],
  '*.{js,ts,vue,mjs,cjs,json,yml,yaml,md,scss}': ['prettier --write'],
}
