import js from '@eslint/js'
import vue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import prettier from 'eslint-plugin-prettier'
import prettierConfig from 'eslint-config-prettier'

// src/core 的 import 清单。核心层只能 import 自己 —— 任何跨出 src/core 的引用都要挡掉。
// no-restricted-imports 比对的是 import 字面量而不是解析后的路径,所以"跨出 core"这件事只能
// 按文件深度表达:src/core/x.ts 用 ../,src/core/a/x.ts 用 ../../,依此类推。
// 不能图省事直接禁 **/platform/**:src/core/platform/ 放的是 core 自己定义的接口
// (如 KeyValueStore),那正是 agent.md §2.1 指定的做法,一刀切会让照着文档写的人撞上误报。
const CORE_FORBIDDEN_PACKAGES = ['vue', 'pinia']
const CORE_FORBIDDEN_LAYERS = [
  '**/platform/web/**',
  '**/composables/**',
  '**/components/**',
  '**/services/**',
  '**/stores/**',
  '**/views/**',
  '**/admin/**',
  '**/generated/**',
]

// 同一条规则在后面的配置块里是覆盖而非合并,所以每个深度都要带上完整清单
function coreImportRule(escapePrefix) {
  const patterns = [
    {
      group: [...CORE_FORBIDDEN_PACKAGES, ...CORE_FORBIDDEN_LAYERS],
      message: 'src/core 必须保持平台无关:不要引用 Vue、平台实现或应用层模块',
    },
  ]
  if (escapePrefix) {
    patterns.push({
      group: [`${escapePrefix}*`, `${escapePrefix}**`],
      message: 'src/core 不得 import 核心层以外的模块:在 core 里定义接口,交给 platform 实现',
    })
  }
  return ['error', { patterns }]
}
export default tseslint.config(
  { ignores: ['dist', 'coverage', '.wrangler'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  prettierConfig,
  {
    files: ['**/*.ts', '**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
    plugins: {
      prettier,
    },
    rules: {
      'no-undef': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'prettier/prettier': 'error',
    },
  },
  // 核心层的边界:src/core 必须保持平台无关,才能原样搬到桌面端。
  // 类型层面的保证在 tsconfig.core.json(不加载 DOM 类型库),这里守住运行时的两条:
  // 不引用核心层以外的模块,不使用浏览器全局
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': coreImportRule(null),
      'no-restricted-globals': [
        'error',
        ...[
          'window',
          'document',
          'navigator',
          'localStorage',
          'sessionStorage',
          'indexedDB',
          'location',
          'history',
          'screen',
          'caches',
          'fetch',
          'matchMedia',
          'requestAnimationFrame',
          'cancelAnimationFrame',
          'performance',
          'Audio',
          'AudioContext',
          'Image',
        ].map((name) => ({
          name,
          message: 'src/core 必须保持平台无关:把它做成参数或接口,由 platform 层注入',
        })),
      ],
    },
  },
  // 按深度挡住"刚好跨出 src/core"的那一段相对路径,core/platform 里的接口不受影响
  { files: ['src/core/*.ts'], rules: { 'no-restricted-imports': coreImportRule('../') } },
  { files: ['src/core/*/*.ts'], rules: { 'no-restricted-imports': coreImportRule('../../') } },
  {
    files: ['src/core/*/*/*.ts'],
    rules: { 'no-restricted-imports': coreImportRule('../../../') },
  },
  // 状态层不认识服务层:需要服务能力时由 src/app/ 的组装点注册进来
  {
    files: ['src/stores/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/services/**'],
              message: 'stores 不得 import services:暴露注册钩子,由 src/app/ 组装点装上',
            },
          ],
        },
      ],
    },
  },
  // 服务层的对外请求要走可注入的传输口,桌面端才能整体换掉
  {
    files: ['src/services/**/*.ts'],
    ignores: ['src/services/http.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: '改用 services/http.ts 的 httpFetch,传输方式要能被桌面端替换',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.{js,mjs,cjs}', '*.config.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
)
