# REQ-SERVER 单进程单端口服务端

## 1. 目标

**一个进程、一个端口**同时承载三件事：HTTP API、WebSocket、前端页面。开发和生产环境的拓扑必须完全一致 —— 没有独立的 Vite dev server，没有反向代理，没有 CORS 转发。

这样做的收益：

- 前端代码永远用相对路径，不存在"开发能跑、上线跨域"的问题；
- Cookie 天然同源，BFF 鉴权（[REQ-AUTH](02-auth-keycloak.md)）和 WebSocket 握手鉴权都能直接拿到；
- 部署物只有一个容器、一个端口、一个健康检查。

## 2. 功能需求

### 2.1 运行方式

- 用 `tsx` 直接运行 TypeScript，**服务端不做打包**。开发用 `tsx watch`，生产用 `tsx`。
- 唯一入口是 `server/index.ts`；`pnpm dev` / `pnpm start` 都指向它。
- `NODE_ENV !== 'production'` 即视为开发环境。

### 2.2 启动顺序

1. 加载 `.env`（`process.loadEnvFile()`，**不引入 dotenv**；真实环境变量优先于 `.env`）；
2. `assertAuthConfig()` —— 生产环境缺鉴权配置直接终止启动；
3. 用 `createAdaptorServer` 建 http server，**先不 listen**；
4. 挂载协同 WebSocket 服务；
5. 挂载前端（dev / prod 两种实现）；
6. 启动每小时一次的过期会话清扫；
7. 开始监听。

拆成"先建后听"是因为 WebSocket upgrade 和 Vite HMR 都需要拿到同一个 http server 实例。

### 2.3 请求分发优先级

```
/ws/*      → WebSocket upgrade（见 REQ-COLLAB）
/api/*     → Hono 路由（登录校验在此生效）
其余       → 前端（dev: Vite 中间件；prod: dist 静态资源）
```

- `/api/*` 必须**先于**前端的 catch-all 注册，保证 API 路径永远不会被前端兜底吞掉。
- 未匹配到的 `/api/*` 返回统一的 404 JSON；未捕获异常返回统一的 500 JSON。

### 2.4 中间件

- 日志（logger）与 CORS，CORS 只放开 `APP_ORIGIN`。
- `withSession` 全局解析会话；随后对 `/api/*` 上除公开路径（`/api/health`、`/api/auth`）外的全部路由加 `requireAuth`。
- Hono app 的类型是 `Hono<{ Bindings: HttpBindings; Variables: AuthVariables }>`：前端中间件要用 `c.env` 拿 Node 原始 `req`/`res`，鉴权中间件要往 `Variables` 里放 `session`/`user`。

### 2.5 开发环境的前端

- 以 **middleware 模式**创建 Vite（`appType: 'custom'`，`server.middlewareMode: true`），把它的 connect 中间件链跑在 `c.env.incoming/outgoing` 上，处理器返回 `RESPONSE_ALREADY_SENT`。
- 中间件链调用 `next()` 时走 SPA 兜底：读 `index.html` 并经 `vite.transformIndexHtml` 处理后返回。
- HMR 必须复用同一个端口：创建 Vite 时传 `hmr: { server }`。只写 `middlewareMode: { server }` 的话 Vite 仍会另开 24678 端口。
- Vite 只在开发环境被**动态 import**，保证生产运行时完全不加载它。

### 2.6 生产环境的前端

- 用 `serveStatic` 提供 `dist/`，未知路径回退到 `index.html`（SPA 路由）。
- `vite.config.ts` 是唯一的构建配置来源，`vite build` 和 middleware 模式共用它；里面**不应该**再有 `server.proxy`。

### 2.7 API 路由约定

- 一个资源一个 Hono 子应用，放在 `server/routes/`，统一挂到 `/api/*` 下。
- 路由必须**链式书写**（`new Hono().get(...).post(...)`），这样导出的 `AppType` 才能被 `hc<AppType>()` 推断，前端可选地享受 RPC 类型。
- 现有路由：

| 路径 | 说明 |
|---|---|
| `GET /api/health` | 健康检查，返回 `{ status, uptime, timestamp }`，公开 |
| `/api/auth/*` | 见 [REQ-AUTH](02-auth-keycloak.md)，公开 |
| `/api/notes/*` | 见 [REQ-DATA](05-data-persistence.md) |
| `GET /api/collab/rooms` | 见 [REQ-COLLAB](04-realtime-collab.md) |

### 2.8 配置项

`server/config.ts` 统一导出：`rootDir` / `distDir` / `isDev` / `port` / `host` / `isApiPath()` / `dataDir` / `databaseUrl` / `ensureDatabaseDir()` / `appOrigin` / `authConfig` / `authEnabled` / `assertAuthConfig()`。

| 变量 | 默认值 |
|---|---|
| `PORT` | 3000 |
| `HOST` | 127.0.0.1（容器内为 0.0.0.0） |
| `NODE_ENV` | 非 `production` 即开发环境 |

> 注意：`config.ts` 在模块加载时把环境变量固化成常量。测试中要换环境必须 `vi.resetModules()` + 动态 `import()`。

### 2.9 关停

- 必须响应 `SIGINT` / `SIGTERM`，做完清理（关闭 WebSocket、断开数据库、停止定时任务）再退出。

### 2.10 类型检查

- `server/` 是**独立的 TS 工程**（`server/tsconfig.json`，Node 类型、无 DOM lib），由根 `tsconfig.json` 引用。
- `server/` 内部的相对导入必须带 `.ts` 扩展名。
- `pnpm typecheck:server` 单独检查这个工程。

## 3. 验收标准

- [ ] `pnpm dev` 后只有一个进程、一个端口；`lsof` 看不到 24678。
- [ ] 开发环境改前端源码触发 HMR，无需刷新页面。
- [ ] 开发环境改 `server/` 源码触发进程重启。
- [ ] `pnpm preview`（build + 生产模式启动）后，直接访问 `/three-editor` 这类深层路由能正确返回页面而不是 404。
- [ ] 生产模式下进程内没有加载 Vite（依赖被 prune 掉也能启动）。
- [ ] `GET /api/health` 免登录可访问；`GET /api/notes` 未登录返回 401。
- [ ] 不存在的 `/api/xxx` 返回 JSON 格式 404，而不是 `index.html`。
- [ ] `Ctrl-C` 能干净退出，不留孤儿进程。

## 4. 本期不做

- 多实例 / 水平扩展（协同文档在内存、SQLite 单文件，只能 `replicas: 1`）。
- 服务端渲染（SSR）/ 预渲染。
- 请求限流、熔断。
- 结构化日志与链路追踪。

## 5. 待确认事项

- 生产环境是否需要给静态资源加长缓存头 + 文件名哈希（当前依赖 Vite 默认产物命名）。
- `store/notes.ts` 之外的业务数据是否统一走 Prisma，还是继续保留内存实现作为演示。
