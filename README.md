# shadecn-learning

Vue 3 + shadcn-vue + Three.js 的学习 / 实验沙盒，pnpm monorepo：

```
apps/web           @shadecn/web              前端（Vue 3 + Vite），@/ → apps/web/src
apps/platform      @learning/platform        后端（NestJS + Fastify），托管前端和全部业务 API，默认端口 3001
apps/collab        @learning/collab-service  协同副本（拆开部署时用）和本地前置代理
apps/agent-runner  @learning/agent-runner    画布 agent 的 oci runner 镜像
packages/shared    @shadecn/shared           前端用的契约（source-only TS）
packages/*         @learning/*               后端的各个 Nest 模块和库（清单见 CLAUDE.md）
docs/              需求文档（索引见 docs/README.md）
```

常用命令都在仓库根执行（内部是 `pnpm --filter` 委托）：

- `pnpm dev` —— 启动平台（Vite 中间件 + watch），http://127.0.0.1:3001。配置放 `data/config.yaml`（示例 `apps/platform/config.example.yaml`），密钥放 `apps/platform/.env`（示例 `apps/platform/.env.example`）；每个页面和 `/api` 都要登录，先配好登录方式
- `pnpm build` / `pnpm start` —— 构建（前端到 `output/public`，平台到 `apps/platform/dist`）并以生产模式运行
- `pnpm dev:front` —— 从产物起一个平台 + 协同副本 + 前置代理
- `pnpm build:agent-runner-image` —— 构建画布 agent 的 oci runner 镜像
- `pnpm test`（`test:client` / `test:shared` / `test:platform` / `test:<包名>`）、`pnpm lint`、`pnpm typecheck:platform` / `typecheck:shared` / `typecheck:<包名>`

架构、约定与各种「为什么」见 [CLAUDE.md](CLAUDE.md)。
