import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"
import pluginVue from "eslint-plugin-vue"
import prettierConfig from "eslint-config-prettier"
import vueParser from "vue-eslint-parser"
import security from "eslint-plugin-security"
import { importX } from "eslint-plugin-import-x"
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript"
import { defineConfig } from "eslint/config"

export default defineConfig(
  // Global ignores
  {
    ignores: [
      "dist",
      "apps/platform/dist",
      "packages/config/dist",
      "packages/web/dist",
      "packages/foundation/dist",
      "packages/data-access/dist",
      "packages/session/dist",
      // `pnpm build` 的产物
      "output",
      "node_modules",
      "apps/web/src/components/ui/**"
    ]
  },
  {
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      security
    }
  },
  // Base JS recommended
  js.configs.recommended,

  // TypeScript — recommended (no type-checked) + stylistic
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,

  // Vue 3 — essential + strongly-recommended
  ...pluginVue.configs["flat/recommended"],
  ...pluginVue.configs["flat/strongly-recommended"],
  security.configs.recommended,

  // Prettier — must be last, disables formatting rules
  prettierConfig,

  // Global language options — browser globals
  // packages/shared 除外：它前后端都要跑，不该假设浏览器（也不该假设 Node，所以下面的 Node 块也没有它）。
  // 「不许用 DOM / Node 专属 API」真正的护栏是它自己 tsconfig 的 lib: ES2020 + types: []，这里只是不给错觉。
  // packages/agent 也除外：它是纯服务端包（画布 Agent），归下面的 Node 块。
  {
    ignores: ["packages/shared/**", "packages/agent/**"],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },

  // Node 后端 —— Node 全局变量
  {
    files: [
      // 后端包整个是 node 环境（含 prisma.config.ts、vitest.config.ts）
      "apps/server/**/*.ts",
      // 构建脚本和随产物发出去的模板，都是 node 环境
      "apps/server/scripts/**/*.{js,mjs}",
      "apps/agent-sandbox/**/*.{ts,mjs}",
      "apps/platform/**/*.ts",
      "packages/config/**/*.ts",
      "packages/web/**/*.ts",
      "packages/foundation/**/*.ts",
      "packages/data-access/**/*.ts",
      "packages/session/**/*.ts",
      "scripts/**/*.mjs",
      // provider / 连接串解析，prisma.config.ts 和构建脚本共用的那份
      "apps/server/prisma/*.mjs",
      "apps/web/vite.config.ts",
      "apps/web/vite-plugins/**/*.ts",
      "apps/web/vitest.config.ts",
      "packages/shared/vitest.config.ts",
      // 画布 Agent 包整个是 node 环境（沙箱要 spawn 子进程、读写文件）
      "packages/agent/**/*.ts",
      "vitest.config.ts",
      "eslint.config.ts"
    ],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },

  // Vue-specific parser config
  {
    files: ["**/*.vue"],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".vue"]
      }
    }
  },

  // 前端循环依赖：写代码时就报，不必等 `vite build` 的 onwarn（那里仍是最后一道关，只报第一个环）。
  // 只管自家模块；第三方包自带的环改不了（ignoreExternal）。
  {
    files: ["apps/web/src/**/*.{ts,vue}"],
    plugins: {
      "import-x": importX
    },
    // 这条规则会顺着 import 解析别的文件，用的是**当前文件**的 parserOptions：
    // .ts 也得带上 parser，否则它引到的 .vue 按纯 JS 解析失败，被悄悄当成没有 import，环就漏了。
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser
      }
    },
    settings: {
      "import-x/extensions": [".ts", ".vue", ".js"],
      "import-x/parsers": {
        "vue-eslint-parser": [".vue"],
        "@typescript-eslint/parser": [".ts"]
      },
      "import-x/resolver-next": [
        createTypeScriptImportResolver({
          project: "apps/web/tsconfig.app.json",
          extensions: [".ts", ".vue", ".js", ".json"]
        })
      ]
    },
    rules: {
      "import-x/no-cycle": ["error", { ignoreExternal: true }]
    }
  },

  // Custom rule overrides
  {
    rules: {
      "vue/multi-word-component-names": "off",
      "vue/attributes-order": "off",
      "vue/no-mutating-props": "error",
      "security/detect-non-literal-regexp": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" }
      ],
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/prefer-function-type": "off",
      "@typescript-eslint/consistent-generic-constructors": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-expressions": "warn"
    }
  }
)
