# REQ-DEPLOY 构建与部署

## 1. 目标

一个镜像、一个端口、一个卷就能跑起来。**没有 nginx，没有反向代理，没有独立数据库服务** —— Node 进程自己吐静态资源（见 [REQ-SERVER](03-server-runtime.md)）。

## 2. 构建需求

### 2.1 命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 开发（Node/Hono + Vite 中间件，watch 模式），http://127.0.0.1:3000 |
| `pnpm build` | `vue-tsc -b` 类型检查 → `vite build` 输出 `dist/` |
| `pnpm start` | 生产模式启动（`NODE_ENV=production`，服务 `dist/`） |
| `pnpm preview` | `build` + `start` |

**前端打包，后端不打包** —— 后端用 `tsx` 直接运行 `.ts`，所以 `tsx` 和 `prisma` 都在 `dependencies` 而不是 `devDependencies`。

### 2.2 Dockerfile（两阶段）

**build 阶段**

1. 基于 `node:22-alpine`，安装 `python3 make g++` —— **better-sqlite3 在 musl 上没有预编译包，必须现场编译**；
2. 先只拷 `package.json` / `pnpm-lock.yaml` / `prisma.config.ts` / `prisma/`，再 `pnpm install --frozen-lockfile`（`postinstall` 会跑 `prisma generate`，所以 schema 必须先到位）；
3. 拷入全部源码后**再 `prisma generate` 一次**，确保 `server/generated/prisma` 是最新 schema 的产物；
4. `vite build`；
5. `pnpm prune --prod`。

**运行时阶段**

- 只拷 `node_modules` / `package.json` / `prisma.config.ts` / `prisma/` / `server/` / `dist/`；
- `ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data`；
- 建好 `/app/data` 并声明为 `VOLUME`；
- `EXPOSE 3000`；
- 启动命令：**先 `prisma migrate deploy`，再 `tsx server/index.ts`**。

> ⚠️ 跨架构构建：build 阶段带了 `--platform=$BUILDPLATFORM`。在 amd64 机器上构 arm64 镜像时，better-sqlite3 编译出来的是 amd64 的 `.node`。这种情况必须去掉那个 `--platform`，或改用 QEMU 构建。

## 3. Kubernetes 部署需求

`k8s/` 下有 Deployment、Service、Ingress。

### 3.1 硬约束

- **`replicas: 1`**、**`strategy: Recreate`**。
  原因有两条，任一条都足够：SQLite 是单文件（ReadWriteOnce 的卷不允许两个 Pod 同时挂载）；Yjs 文档全在进程内存里（多副本之间无法同步）。
  滚动更新会短暂存在两个 Pod，因此必须用 `Recreate`。

### 3.2 存储

- 1Gi PVC，`ReadWriteOnce`，挂到 `/app/data`。
- `DATA_DIR=/app/data`，库文件即 `/app/data/app.db`。

### 3.3 配置

明文环境变量（在 Deployment 里）：`NODE_ENV`、`HOST`、`PORT`、`DATA_DIR`、`APP_ORIGIN`、`KEYCLOAK_ISSUER`、`KEYCLOAK_CLIENT_ID`。

密钥走 Secret（`envFrom.secretRef`）：`KEYCLOAK_CLIENT_SECRET`、`SESSION_SECRET`。

```bash
kubectl -n dev create secret generic shadecn-learning-auth \
  --from-literal=KEYCLOAK_CLIENT_SECRET=xxx \
  --from-literal=SESSION_SECRET=$(openssl rand -hex 32)
```

**真值不得提交进仓库** —— 仓库里的 Secret 清单只是占位模板。

部署前必须按实际环境改：`APP_ORIGIN`、`KEYCLOAK_ISSUER`、镜像地址。`APP_ORIGIN` 必须与 Keycloak client 里配的 redirect URI 一致，否则登录回调失败。

### 3.4 探针与资源

- liveness / readiness 都探 `GET /api/health`（该端点免登录）。
- liveness：initialDelay 5s / period 30s；readiness：initialDelay 3s / period 10s。
- requests `100m / 128Mi`，limits `500m / 512Mi`。

### 3.5 Ingress

- 需要支持 **WebSocket** 透传（`/ws/*`）。
- 建议启用 TLS；生产环境的会话 Cookie 依赖 HTTPS。

## 4. 验收标准

- [ ] `docker build` 在干净环境下成功，better-sqlite3 编译通过。
- [ ] 容器首次启动时自动建库、跑完迁移再对外服务。
- [ ] 删除 Pod 重建后，`/app/data` 中的数据仍在（用户和会话不丢）。
- [ ] 通过 Ingress 完整走通 Keycloak 登录回跳。
- [ ] 通过 Ingress 能建立 `/ws/<room>` WebSocket 连接。
- [ ] 缺少 `KEYCLOAK_ISSUER` 时容器启动失败并给出明确报错（不能静默放行）。
- [ ] `/api/health` 返回 200，探针不误杀。

## 5. 本期不做

- 水平扩展 / 高可用（架构上被 SQLite + 内存文档挡住）。
- CI/CD 流水线（镜像目前是手工构建推送）。
- 蓝绿 / 金丝雀发布。
- 数据库备份与灾备。
- HPA、PDB、NetworkPolicy。

## 6. 待确认事项

- 镜像 tag 目前是提交短 hash 手写进 yaml，是否改为 CI 自动替换。
- 需要多副本时的演进路线：换 Postgres + 给 Yjs 加跨进程广播，还是接受单副本。
- 是否需要为静态资源单独配 CDN / 缓存策略。
