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
      "node_modules",
      "src/components/ui/**",
      // Prisma 生成的 client
      "server/generated/**"
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
  {
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },

  // Node 后端 —— Node 全局变量
  {
    files: [
      "server/**/*.ts",
      "vite.config.ts",
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
