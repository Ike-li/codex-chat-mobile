// eslint.config.js —— ESLint 9 flat config。
// 分组:Node 后端/脚本/测试(ESM)+ 浏览器 Service Worker。
// 说明:public/index.html 的内联脚本未纳入(需 eslint-plugin-html;当前保持最小依赖)。
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'data/**',
    ],
  },
  js.configs.recommended,
  {
    // Node 后端、脚本、测试、Playwright 配置(项目为 type:module,.js 即 ESM)。
    files: ['**/*.js', '**/*.mjs'],
    ignores: ['public/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // 浏览器 Service Worker(经典脚本,非 module)。
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.serviceworker, ...globals.browser },
    },
  },
];
