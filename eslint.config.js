import js from '@eslint/js'
import vue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import prettier from 'eslint-plugin-prettier'
import prettierConfig from 'eslint-config-prettier'

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
  // 不引用平台实现,不使用浏览器全局
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'vue',
                'pinia',
                '**/platform/**',
                '**/composables/**',
                '**/components/**',
                '**/services/**',
                '**/stores/**',
                '**/views/**',
                '**/admin/**',
                '**/generated/**',
              ],
              message: 'src/core 必须保持平台无关:不要引用 Vue、平台实现或应用层模块',
            },
          ],
        },
      ],
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
