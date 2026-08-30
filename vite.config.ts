import path from 'node:path'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'

/**
 * 画布编辑器的模块 —— 下面的 onwarn 只对这片代码把「循环依赖」当错误。
 *
 * 为什么不是全仓库：`src/components/ui/` 下每个 shadcn-vue 组件都和自己那个
 * `index.ts` 互相引（`index.ts` → `Button.vue` → `index.ts`），是 CLI 生成的形状，
 * 改不了也没必要改 —— 一个 barrel 和它自己的组件总是落在同一个 chunk 里，
 * rollup 不用跨 chunk 挑顺序，从来没出过事。真正咬人的是环**跨了 chunk**那种。
 */
const FLOW_MODULE = /src\/(components|composables)\/flow\//

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    /**
     * Yjs 全进程只能有一份。
     *
     * 我们的代码和 `@hocuspocus/provider` 各自 `import * as Y from 'yjs'`，
     * 而 Vite 的依赖预打包会把 yjs 一起打进 provider 的产物里 —— 于是浏览器里
     * 出现两个副本，控制台会喊 "Yjs was already imported"
     * （https://github.com/yjs/yjs/issues/438）。
     *
     * 这不只是告警：两份副本意味着两套类之间的 `instanceof` **永远为 false**，
     * 而 `src/lib/flow-doc.ts` 通篇靠 `value instanceof Y.Map` 判断节点结构 ——
     * 静默失效的话，画布会变成一张空图。
     * y-protocols 同理（awareness 也做 instanceof 检查）。
     */
    dedupe: ['yjs', 'y-protocols'],
  },
  server: {
    /**
     * 允许哪些 Host 头打进 dev server（`DEV_ALLOWED_HOSTS`，逗号分隔）。
     *
     * Vite 缺省只认 localhost 一类的本机名，别的 Host 一律 403「Blocked request」。
     * 那**不是多余的严格**：dev server 上挂着 HMR 与任意文件读取能力，而浏览器对
     * 一个域名的同源限制拦不住 DNS rebinding —— 攻击者把自己的域名解析到 127.0.0.1，
     * 就能让受害者的浏览器替他读本机源码。故这里**只加名单、不关这道门**
     * （`allowedHosts: true` 等于对任意域名敞开）。
     *
     * 调试用途：把本机这个 dev server 挂到集群的 ingress 后面时，进来的 Host 是那个域名，
     * 不加进来就是一句 403，而它长得**很像**网关或鉴权拒绝，很容易往错的方向查。
     *
     * ⚠️ 只影响 dev；`vite build` 不读它。
     */
    allowedHosts: (process.env.DEV_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  },
  build: {
    // 前端产物直接落进后端的静态资源目录：output/ 里就是一份完整可跑的东西
    outDir: path.resolve(__dirname, 'output/public'),
    emptyOutDir: true,
    rollupOptions: {
      /**
       * 两个 HTML 入口，不是一个 SPA。
       *
       * `login.html` 必须独立成一个入口，因为**未登录时后端不发 `index.html`**
       * （页面闸门只放行 `/login` 这一次导航，见 server/frontend/guard.ts）——
       * 登录页要是长在 SPA 里，就成了「要先进应用才能登录」。
       *
       * 共享部分（Vue、shadcn 组件、Tailwind 主题变量）由 rollup 提成公共 chunk，
       * 两个入口共用，所以登录页复用配色和组件是**零重复**的 —— 这正是它从
       * 服务端拼字符串搬到 src 下的理由。
       */
      input: {
        index: path.resolve(__dirname, 'index.html'),
        login: path.resolve(__dirname, 'login.html'),
      },

      /**
       * 跨 chunk 的循环 re-export **直接构建失败**，不要只是警告。
       *
       * rollup 原话是 "will likely lead to broken execution order" —— 落到浏览器里
       * 就是 `ReferenceError: Cannot access 'XX' before initialization`：先被求值的
       * chunk 用到了另一个还没初始化完的 chunk 里的绑定。
       *
       * 它只在**生产构建**里出现：dev 是原生 ESM，live binding 让环自己解开，
       * 所以本地怎么点都是好的，一上线整页白屏。这种「只有线上才炸」的东西必须卡在
       * 构建上 —— 真发生过一次（barrel `@/composables/flow` ↔ 节点组件成环，
       * 存量画布全打不开），当时这条警告就在 build 日志里，滚过去了没人看见。
       *
       * 触发之后不要靠 manualChunks 去把它们塞进同一个 chunk —— 那只是把环藏起来。
       * 断环：让被引的那一侧变成不 import 任何东西的叶子模块
       * （`src/composables/flow/editor-context.ts`、`src/components/flow/node-constants.ts`
       * 就是这么来的）。
       */
      onwarn(warning, defaultHandler) {
        if (warning.code === 'CYCLIC_CROSS_CHUNK_REEXPORT') {
          throw new Error(`[build] 存在跨 chunk 的循环 re-export，拒绝构建：\n${warning.message}`)
        }
        if (warning.code === 'CIRCULAR_DEPENDENCY' && FLOW_MODULE.test(warning.message ?? '')) {
          throw new Error(`[build] 画布模块之间出现循环依赖，拒绝构建：\n${warning.message}`)
        }
        defaultHandler(warning)
      },
    },
  },
})

// 注意：dev 时不再由 vite 自己起服务，而是被 server/frontend/dev.ts 以中间件模式挂到
// Node 后端上（`pnpm dev`），所以这里不需要 proxy —— /api、/ws/collaboration 本来就同源同端口。
// 这份配置只剩两个用途：被 `vite build` 读取，以及被中间件模式的 createServer 读取。
