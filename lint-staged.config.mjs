export default {
  '*.{js,ts,vue,mjs,cjs}': [() => 'pnpm lint', () => 'pnpm type-check'],
  '*.{js,ts,vue,mjs,cjs,json,yml,yaml,md,scss}': [() => 'pnpm format'],
}
