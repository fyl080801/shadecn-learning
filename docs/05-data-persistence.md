# REQ-DATA 数据存储与业务 API

> 状态：**部分实现** —— 鉴权数据已落 SQLite；业务数据（notes）仍是内存实现，作为 API 形态的样板。

## 1. 目标

给应用一个**零外部依赖**的持久层：不需要单独部署数据库服务，一个文件即全部状态，同时保证 CLI（迁移工具）和服务端进程永远打开同一个库文件。

## 2. 选型约束

| 选择 | 理由 |
|---|---|
| SQLite | 单文件、无需额外服务；配合 PVC 就能在 k8s 上跑 |
| Prisma 7 | 迁移工具链完整；7.x 强制要求 driver adapter |
| `@prisma/adapter-better-sqlite3` | Prisma 7 的 SQLite driver adapter |
| client 生成到 `server/generated/prisma` | 生成为 TypeScript 源码而非塞进 `node_modules`，这样 `pnpm prune --prod` 之后依然存在，能跟着 `server/` 一起进镜像 |

生成目录必须 gitignore、`@ts-nocheck`、并在 eslint 中忽略。改完 schema 必须跑 `pnpm db:generate`。

## 3. 功能需求

### 3.1 数据库文件位置

解析规则（`server/config.ts` 与 `prisma.config.ts` 必须**保持一致**）：

1. 设了 `DATABASE_URL` → 直接用它，覆盖一切；
2. 否则库文件为 `$DATA_DIR/app.db`；
3. `DATA_DIR` 默认为仓库根目录下的 `data/`（已 gitignore）；
4. 两者中的**相对路径都以仓库根目录为基准，不是 cwd**；
5. 两边都要 `mkdir -p` 父目录 —— better-sqlite3 不会自动建目录。

> 这条一致性是硬要求：CLI 迁移和服务端运行时必须操作同一个文件，否则会出现"迁移跑了但服务端说表不存在"。

### 3.2 数据模型

| 模型 | 用途 | 关键约束 |
|---|---|---|
| `User` | 从 Keycloak id_token / userinfo 落下来的用户档案 | `@@unique([issuer, subject])` —— 换 realm 即视为另一个人；`roles` 因 SQLite 无数组类型，存成 JSON 字符串 |
| `Session` | 服务端会话，存 access / refresh / id token | 主键是 Cookie 中随机 token 的 **HMAC-SHA256**（密钥 `SESSION_SECRET`），token 本身不落库；`userId` 建索引；随 User 级联删除 |
| `AuthRequest` | 一次授权请求的临时凭据（state / nonce / PKCE verifier / redirectTo） | `state` 唯一；回调时一次性消费；过期由定时清扫回收 |

字段级说明见 `prisma/schema.prisma` 中的注释。

### 3.3 客户端单例

- `server/db.ts` 导出唯一的 `PrismaClient`，缓存在 `globalThis` 上，避免 `tsx watch` 每次热重启泄漏连接。

### 3.4 迁移

| 命令 | 作用 |
|---|---|
| `pnpm db:generate` | 重新生成 client（改完 schema 必跑；`postinstall` 也会跑） |
| `pnpm db:migrate` | 开发环境建 / 改表并生成迁移文件 |
| `pnpm db:deploy` | 生产环境应用已有迁移（容器启动时自动执行） |
| `pnpm db:studio` | 可视化查看数据 |

- 迁移文件必须提交进仓库；生产环境**只允许** `migrate deploy`，不允许 `migrate dev`。

### 3.5 业务 API 样板：`/api/notes`

当前是内存 `Map` 实现（`server/store/notes.ts`），进程重启即清空，启动时预置两条示例数据。它的价值是定义**业务路由应该长什么样**：

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/notes` | 列表，按 `createdAt` 升序 |
| GET | `/api/notes/:id` | 单条；不存在 → 404 `{ error: 'Note not found' }` |
| POST | `/api/notes` | 新建，成功返回 **201** + 实体 |
| PATCH | `/api/notes/:id` | 局部更新；不存在 → 404 |
| DELETE | `/api/notes/:id` | 删除，成功返回 **204** 空 body；不存在 → 404 |

校验要求：

- 请求体不是合法 JSON → 400 `{ error: '请求体不是合法 JSON' }`；
- `title` 必须是非空字符串（POST 必填，PATCH 可缺省），否则 400；
- `content` 必须是字符串，POST 缺省时默认为 `''`；
- 所有错误响应统一为 `{ error: string }`。

分层要求：**路由层只做参数校验和状态码，数据访问全在 `store/` 里**。把内存实现换成 Prisma 时，路由文件不应有任何改动。

## 4. 验收标准

- [ ] 全新克隆仓库后执行 `pnpm install && pnpm db:migrate`，`data/app.db` 被自动创建（含父目录）。
- [ ] 在任意子目录下执行 `pnpm db:migrate` 与 `pnpm dev`，两者操作的是同一个库文件。
- [ ] `pnpm prune --prod` 之后服务端仍能启动（生成的 client 未被删掉）。
- [ ] 未登录访问 `/api/notes` 返回 401。
- [ ] notes 的五个端点全部符合上表的状态码与错误格式，并有对应测试覆盖。
- [ ] 删除 `data/app.db` 后重新 `db:deploy` 能从零重建全部表结构。

## 5. 本期不做

- 把 notes 从内存迁到 Prisma（等真正需要持久化的业务出现再做）。
- 软删除、审计日志、乐观锁。
- 分页、排序、过滤参数。
- 数据库备份 / 恢复方案。
- 换成 Postgres / MySQL（会牺牲"零外部依赖"这个前提）。

## 6. 待确认事项

- `notes` 是继续当纯样板，还是作为第一个真实持久化业务落库。
- SQLite 单写入者模型在协同场景下是否够用（若 [REQ-COLLAB](04-realtime-collab.md) 要落盘则需重新评估）。
