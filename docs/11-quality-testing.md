# REQ-QA 质量保障：测试、类型、Lint

## 1. 目标

沙盒项目也要有生产级的质量底线。三道闸门：**类型检查**、**Lint**、**测试**，任何一道不过都不算完成。

测试的额外要求：**必须是密闭的（hermetic）** —— 一台没配过 `.env`、没有 Keycloak、没网的机器上 `pnpm test` 必须能全绿。

## 2. 测试需求

### 2.1 双 project 结构

一份 `vitest.config.ts`，两个 project：

| project | 环境 | 覆盖范围 | 命令 |
|---|---|---|---|
| `server` | node | `server/test/**/*.test.ts` | `pnpm test:server` |
| `client` | jsdom（+ vue 插件 + `@/` 别名） | `src/test/**/*.test.ts` | `pnpm test:client` |

`pnpm test` 跑全部，`pnpm test:watch` 监听模式，`pnpm test:coverage` 输出 v8 覆盖率到 `coverage/`（text + html）。

覆盖率统计排除：`server/generated/**`、两个 test 目录、`src/components/ui/**`（shadcn 生成物）、`*.d.ts`。

### 2.2 密闭性（硬要求）

三重隔离，缺一不可：

1. **不许联网** —— 两个 project 的 setup 文件都把 `globalThis.fetch` 换成一个**直接 reject** 的桩。任何需要网络的测试必须显式 `vi.stubGlobal('fetch', …)`，不存在"不小心打到真实 Keycloak"这种可能。
2. **不许读开发者的 `.env`** —— `server/env.ts` 在测试中被 alias 到 `server/test/stubs/env.ts`（空实现）。环境变量**全部**由 `vitest.config.ts` 的 `test.env` 提供（固定的 issuer、client id、session secret 等）。
   > 这一步必须做，因为 `process.loadEnvFile()` 不覆盖已存在的变量 —— 先在 `test.env` 里占好位，本地 `.env` 就再也影响不到测试。
3. **不许污染开发库** —— 测试库固定在 `data/test/` 下，与开发用的 `data/app.db` 分离。

### 2.3 数据库

- `server/test/global-setup.ts` 在**整轮开始前**清空 `data/test/`，并执行**真实的 `prisma db push`**。
  > 用真命令而不是手写建表，是为了让测试库和生产库走同一条建表路径，schema 写错测试就会红。
  > 这个项目没有迁移文件，结构同步就是 db push 这一条（见 [REQ-DATA §3.3.1](05-data-persistence.md)）。
- 所有测试文件共用同一个库，因此 `fileParallelism: false`，串行执行。
- 提供辅助函数：`helpers/db.ts`（`resetDb` / `createUser`）、`helpers/session.ts`（`signIn` → 直接拿到可用的 `sid` Cookie）。
- **同一套后端测试要能在两种库上跑**。默认是 `data/test/app.db`；给 `TEST_DATABASE_URL` 一个 PG 连接串就切过去：

  ```bash
  TEST_DATABASE_URL=postgresql://app:app@127.0.0.1:5432/app_test pnpm test:server
  ```

  PG 分支会给 db push 加上 `--accept-data-loss`：那边删不掉库文件，库里可能留着上一轮的表，
  不允许丢数据就推不上去（**所以只能指专用测试库**）。SQLite 不加这个 flag —— 整个 `data/test/`
  每轮都删掉重建，压根没有数据可丢。生成的 Prisma client 是跟 provider 绑定的，global-setup 会先比对
  `activeProvider`，对不上才重新 `generate` —— 所以来回切库不用手动记得重新生成。

### 2.4 假 Keycloak

`server/test/helpers/oidc.ts` 通过桩化的 `fetch` 提供完整的假 Keycloak：discovery、JWKS、token 端点、end_session，并**内置一对真实 RSA 密钥** —— 因此 `verifyIdToken` 的签名校验是真跑的，不是 mock 掉的。

### 2.5 测试方式

- 后端路由通过 `app.request()` 驱动，**走完整中间件栈**（会话、鉴权、错误处理），不允许直接调用 handler 函数。
- 前端组件测试用 `@vue/test-utils`。视图测试只桩 `@/lib/api`，组件本身、shadcn-vue 组件和 reka-ui 的交互都是真跑的 —— 那些「点了没反应」的坑正是出在这一层。jsdom 里要注意：菜单/对话框走 teleport，元素在 `document.body` 上，`wrapper` 里找不到；`DropdownMenuTrigger` 认 `click`，`TabsTrigger` 认 `mousedown`；`PointerEvent` 和 pointer capture 需要自己补桩。
- 路由守卫测试导入**真实的** `@/router`，只桩掉 `/api/auth/me`。

### 2.6 模块级缓存的处理

`config.ts`（环境变量 → 常量）、`oidc.ts`（10 分钟 discovery / JWKS 缓存）、`src/lib/auth.ts`（会话单例）都在**模块加载时**固化状态。需要不同环境的测试必须 `vi.resetModules()` + 动态 `import()` 重新构造（参考 `server/test/routes/auth.test.ts` 的 `freshApp()`）。

### 2.7 当前覆盖范围

**后端**：`app`（路由挂载与 404/500）、`config`、`auth/oidc`、`auth/session`、`auth/middleware`、`auth/ws`（协同握手的房间级鉴权 + 认定身份）、`frontend/guard`（页面闸门与服务端渲染的登录页）、`routes/auth`、`routes/health`、`routes/notes`、`routes/projects`、`routes/invites`、`routes/flows`（含**画布内容的写入路径**：散场落库、从 `ydoc` 恢复、老 `graph` 自动迁移、CRDT 字段级合并）、`store/notes`、`collab/hardening`（三道防线：悬空边清理 / 内容配额 / awareness 身份防伪）。

**前端**：`lib/utils`、`lib/format`、`lib/id`、`lib/auth`（`fetchSession` / `apiFetch` 完整契约）、`prompt-input` 的 `serialize`（round-trip、换行=段落块的约定）、`operations`（transform / undo / batch / muteHistory）与 `PromptInput.vue` 组件本身（块结构渲染、零宽占位不变式及其自愈）、路由守卫（会话失效 → 整页跳 `/login`）、`stores/flow`（Y.Doc 投影：写入落到文档、别人的改动进投影、**并发改不同字段真合并**、
**撤销只撤自己的**、视口不进文档也不进撤销）、`lib/presence`（占用仲裁与防御性解析，不起 socket）、`composables/useAsyncAction`（防连点守卫：同步上锁、失败解锁、按 key 分行上锁）、`ui/button` 的 `loading`（转圈 + 自动禁用，防止被 `shadcn-vue add` 覆盖回去）、`views/canvas/ProjectHome`（删画布 / 移除成员的二次确认真的发出请求；连点按钮、连按回车、连点确认框都只发一次请求）。

**内容写入路径怎么测**：画布内容没有 REST 写入口，唯一的写路径是「客户端改 Y.Doc → WebSocket 同步 → 落库」。
测试不去起真的 WebSocket（线协议是 Hocuspocus 的事，我们没改），而是直接驱动同一条持久化链路
（`server/test/helpers/collab.ts`：`openRoom` → 改文档 → `closeRoom`）—— 跑的是生产代码，不是替身。

**协同的浏览器级验证不在单测里**：身份防伪、拖动不回弹、HMR 共存这类必须有真实浏览器和真实
WebSocket 才成立的行为，靠 Playwright 脚本手工跑（不在 CI 里）。有一条经验值得记：验证 awareness
防伪时**必须从第二条连接观察** —— `awareness.getStates()` 里自己那条是本地状态，根本不过服务端，
读自己等于什么都没验证。

### 2.8 编写约定

- 测试文件**镜像被测目录**：`server/test/routes/auth.test.ts` ↔ `server/routes/auth.ts`。
- `server/test/` 内的导入保持 `.ts` 扩展名，与 `server/` 一致。
- **Vitest globals 未开启** —— `describe` / `it` / `expect` / `vi` 必须从 `vitest` 显式导入。
- 测试名写**被约束的行为**（「未登录 → 401」），不写被调用的函数名（「测试 requireAuth」）。

## 3. 类型检查需求

- 三个 TS 工程：`tsconfig.app.json`（前端）、`server/tsconfig.json`（后端，Node 类型无 DOM）、`tsconfig.node.json`（构建脚本）。
- `pnpm build` 会先跑 `vue-tsc -b`，**类型不过就不出包**。
- `pnpm typecheck:server` 单独检查后端。
- strict + `noUnusedLocals` + `noUnusedParameters` + `erasableSyntaxOnly`。
- `server/generated/**` 是生成物，`@ts-nocheck`，不参与检查。

## 4. Lint 需求

`pnpm lint` / `pnpm lint:fix`。ESLint flat config，组合：

- `@eslint/js` recommended
- `typescript-eslint` recommended + stylistic（**非** type-checked，保证 lint 速度）
- `eslint-plugin-vue` 的 recommended + strongly-recommended
- `eslint-plugin-security` recommended
- `eslint-config-prettier` **必须放最后**，关掉所有格式化类规则（格式交给 Prettier）

忽略：`dist`、`node_modules`、`src/components/ui/**`（shadcn 生成物）、`server/generated/**`。

关键规则取舍：

| 规则 | 级别 | 说明 |
|---|---|---|
| `vue/no-mutating-props` | error | 改 props 一律禁止 |
| `security/detect-non-literal-regexp` | error | 动态正则必须显式处理 |
| `@typescript-eslint/no-explicit-any` | warn | 允许但会提示（移植代码里有历史包袱） |
| `@typescript-eslint/no-unused-vars` | warn | `_` 前缀豁免 |
| `vue/multi-word-component-names` | off | 视图组件名就是单词 |
| `vue/attributes-order` | off | 不强制属性顺序 |

`server/**`、`vite.config.ts`、`vitest.config.ts`、`eslint.config.ts` 使用 Node 全局变量，其余用浏览器全局变量。

## 5. 验收标准

- [ ] 全新克隆 + `pnpm install` 后，**不创建 `.env`**、断网执行 `pnpm test` 全绿。
- [ ] 本地 `.env` 里配了真实 Keycloak 时，`pnpm test` 结果完全不变。
- [ ] 删掉 `data/test/` 后重跑测试能自动重建。
- [ ] `pnpm build` 在有类型错误时失败并给出准确位置。
- [ ] `pnpm lint` 无 error。
- [ ] `pnpm test:coverage` 能生成 HTML 报告，且不包含生成代码与 UI 组件。

## 6. 本期不做

- CI 流水线（GitHub Actions / Gitea Actions）配置。
- E2E / 浏览器自动化测试（Playwright）。
- 覆盖率阈值门禁。
- 视觉回归测试。
- 3D 相关代码的单元测试（`three-editor`、`director` 目前无测试覆盖）。

## 7. 待确认事项

- 是否给 `three-editor` / `director` 的纯逻辑部分（`characterPose`、`cameraLookAt` 等）补单测 —— 这些是可测的纯函数。
- 是否引入 Prettier 作为独立的格式化检查步骤（当前只是用 `eslint-config-prettier` 关掉冲突规则，没有强制格式化）。
- 是否设置覆盖率下限。
