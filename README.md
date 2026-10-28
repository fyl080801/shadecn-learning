# shadecn-learning

Vue 3 + shadcn-vue + Three.js 的学习 / 实验沙盒，pnpm monorepo：

```
apps/web         @shadecn/web     前端（Vue 3 + Vite），@/ → apps/web/src
apps/server      @shadecn/server  后端（Node + Hono + Hocuspocus + Prisma），单进程、单端口
packages/shared  @shadecn/shared  前后端共用的契约（source-only TS）：flow-graph / flow-doc / canvas / auth / collab
docs/            需求文档（索引见 docs/README.md）
```

常用命令都在仓库根执行，名字与拆 monorepo 之前一致（内部是 `pnpm --filter` 委托）：

- `pnpm dev` —— 先复制 `.env.example` 为 `.env`；启动整个应用，http://127.0.0.1:3000
- `pnpm build` / `pnpm start` —— 构建到 `output/` 并以生产模式运行
- `pnpm test`（`test:server` / `test:client` / `test:shared`）、`pnpm lint`、`pnpm typecheck:server` / `typecheck:shared`

架构、约定与各种「为什么」见 [CLAUDE.md](CLAUDE.md)。
