import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"
import pluginVue from "eslint-plugin-vue"
import prettierConfig from "eslint-config-prettier"
import vueParser from "vue-eslint-parser"
import security from "eslint-plugin-security"
import { defineConfig } from "eslint/config"

export default defineConfig(
  // Global ignores
  {
    ignores: [
      "dist",
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
  {
    ignores: ["packages/shared/**"],
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
      // provider / 连接串解析，prisma.config.ts 和构建脚本共用的那份
      "apps/server/prisma/*.mjs",
      "apps/web/vite.config.ts",
      "apps/web/vitest.config.ts",
      "packages/shared/vitest.config.ts",
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
