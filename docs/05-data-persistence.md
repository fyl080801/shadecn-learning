# REQ-DATA 数据存储与业务 API

> 状态：**部分实现** —— 鉴权与画布数据已落库（SQLite / PostgreSQL 二选一）；业务数据（notes）仍是内存实现，作为 API 形态的样板。

## 1. 目标

默认给应用一个**零外部依赖**的持久层：不需要单独部署数据库服务，一个文件即全部状态，同时保证 CLI（迁移工具）和服务端进程永远打开同一个库。

同时留出**换成 PostgreSQL** 的口子：需要多副本、需要真正的并发写、或者公司里本来就有 PG 时，改两个环境变量就能切过去，业务代码一行不动。

## 2. 选型约束

| 选择 | 理由 |
|---|---|
| SQLite（默认） | 单文件、无需额外服务；配合 PVC 就能在 k8s 上跑 |
| PostgreSQL（可选） | 需要多副本 / 并发写 / 外部托管库时切过去 |
| Prisma 7 | 迁移工具链完整；7.x 强制要求 driver adapter |
| `@prisma/adapter-better-sqlite3` / `@prisma/adapter-pg` | 两种库各自的 driver adapter，`server/db.ts` 按 provider 动态 import |
| client 生成到 `server/generated/prisma` | 生成为 TypeScript 源码而非塞进 `node_modules`，这样 `pnpm prune --prod` 之后依然存在，能跟着 `server/` 一起进镜像 |

生成目录必须 gitignore、`@ts-nocheck`、并在 eslint 中忽略。改完 schema 必须跑 `pnpm db:generate`。

## 3. 功能需求

### 3.1 选哪种库

`DB_PROVIDER` 只接受 `sqlite` / `postgresql`。没设就按 `DATABASE_URL` 的协议推断（`file:` → sqlite，`postgres(ql)://` → postgresql），两个都没有就是 sqlite。

硬性检查（对不上直接启动失败，绝不"猜一个"继续跑）：

- `DB_PROVIDER` 是别的值 → 报错；
- `DB_PROVIDER` 和 `DATABASE_URL` 的协议不一致 → 报错；
- `DB_PROVIDER=postgresql` 却没给 `DATABASE_URL` → 报错。

### 3.2 数据库位置

解析规则（`server/config.ts` 与 `prisma/db-provider.mjs` 必须**保持一致**，后者是 CLI 侧唯一实现）：

1. 设了 `DATABASE_URL` → 直接用它，覆盖一切；
2. 否则（仅 sqlite）库文件为 `$DATA_DIR/app.db`；
3. `DATA_DIR` 默认为仓库根目录下的 `data/`（已 gitignore）；
4. 两者中的**相对路径都以仓库根目录为基准，不是 cwd**；
5. sqlite 两边都要 `mkdir -p` 父目录 —— better-sqlite3 不会自动建目录；PG 无此步。

> 这条一致性是硬要求：CLI 迁移和服务端运行时必须操作同一个库，否则会出现"迁移跑了但服务端说表不存在"。

### 3.3 一份模型，两份 schema

Prisma 的 `datasource.provider` 只能写字面量、一份 schema 也只能有一个 datasource，所以"同时支持"只能是两份 schema 文件：

- `prisma/models.prisma` —— **唯一的手写来源**，只有 generator + model，没有 datasource；
- `prisma/schema.sqlite.prisma` / `prisma/schema.postgresql.prisma` —— `pnpm db:schema` 从上面那份生成，两份都提交进仓库；
- `pnpm db:schema:check` 在 `build:server` 前跑，生成物和模型对不上就构建失败。

模型里**不许出现 provider 专属的东西**（`@db.*` 原生类型、数组、`Json`、enum…），两边生成的 client 类型必须一模一样 —— 这是业务代码不用分叉的前提。`roles` / `tags` 这类字段统一用 `String` 存 JSON 字符串。

迁移历史按 provider 分目录：`prisma/migrations/sqlite/` 和 `prisma/migrations/postgresql/`（DDL 方言不同，不能共用）。PG 的第一条迁移就是全量结构 —— 这个支持是后加的，不存在需要升级的旧 PG 库；从那条往后，改一次模型就在两个目录各加一条同名迁移。

### 3.4 两种库的行为差异

只有一处需要代码补偿：**SQLite 的 `LIKE` 对 ASCII 大小写不敏感，PostgreSQL 的不是**。`server/store/text.ts` 的 `nameContains()` 在 PG 下补 `mode: 'insensitive'`（翻成 `ILIKE`），把两边的搜索结果拉齐。新增模糊搜索一律走它，别直接写 `{ contains }`。

### 3.5 数据模型

| 模型 | 用途 | 关键约束 |
|---|---|---|
| `User` | 从 Keycloak id_token / userinfo 落下来的用户档案 | `@@unique([issuer, subject])` —— 换 realm 即视为另一个人；`roles` 因 SQLite 无数组类型，存成 JSON 字符串 |
| `Session` | 服务端会话，存 access / refresh / id token | 主键是 Cookie 中随机 token 的 **HMAC-SHA256**（密钥 `SESSION_SECRET`），token 本身不落库；`userId` 建索引；随 User 级联删除 |
| `AuthRequest` | 一次授权请求的临时凭据（state / nonce / PKCE verifier / redirectTo） | `state` 唯一；回调时一次性消费；过期由定时清扫回收 |

字段级说明见 `prisma/models.prisma` 中的注释。

### 3.6 客户端单例

- `server/db.ts` 导出唯一的 `PrismaClient`，缓存在 `globalThis` 上，避免 `tsx watch` 每次热重启泄漏连接；adapter 按 provider **动态** import（构建产物里只留用得上的那个）。

### 3.7 迁移

| 命令 | 作用 |
|---|---|
| `pnpm db:schema` | 从 `models.prisma` 生成两份 schema（`db:generate` / `db:migrate` 会自动先跑） |
| `pnpm db:generate` | 重新生成 client（改完模型必跑；`postinstall` 也会跑） |
| `pnpm db:migrate` | 开发环境建 / 改表并生成迁移文件 —— 只生成**当前 provider** 那一份 |
| `pnpm db:deploy` | 生产环境应用已有迁移（容器启动时自动执行） |
| `pnpm db:studio` | 可视化查看数据 |

- 迁移文件必须提交进仓库；生产环境**只允许** `migrate deploy`，不允许 `migrate dev`。
- 改一次模型要生成**两条**迁移：`pnpm db:migrate` 跑一遍 sqlite，再 `DB_PROVIDER=postgresql DATABASE_URL=… pnpm db:migrate` 跑一遍 PG，两条用同一个名字。

### 3.8 业务 API 样板：`/api/notes`

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
- [ ] `pnpm db:schema:check` 在模型改了但没重新生成 schema 时失败。
- [ ] 设 `DB_PROVIDER=postgresql` + PG 的 `DATABASE_URL` 后，`pnpm db:generate && pnpm db:deploy && pnpm dev` 全流程可用，接口行为与 SQLite 一致。
- [ ] `TEST_DATABASE_URL=postgresql://… pnpm test:server` 整套后端测试在 PG 上同样全绿。
- [ ] `DB_PROVIDER` 与 `DATABASE_URL` 协议不一致时启动直接失败，不会连错库。

## 5. 本期不做

- 把 notes 从内存迁到 Prisma（等真正需要持久化的业务出现再做）。
- 软删除、审计日志、乐观锁。
- 分页、排序、过滤参数。
- 数据库备份 / 恢复方案。
- MySQL 等第三种库（模型里就没有为它留的余地）。
- 一份产物同时支持两种库：Prisma 生成的 client 编译期就绑定了查询编译器，构建时必须定下 provider。

## 6. 待确认事项

- `notes` 是继续当纯样板，还是作为第一个真实持久化业务落库。
- SQLite 单写入者模型在协同场景下是否够用（若 [REQ-COLLAB](04-realtime-collab.md) 要落盘则需重新评估）；真要多副本就是切 PG 的时候。
- 切到 PG 后 `flows.commit` 的 `seq` 自增在并发下靠 `@@unique([flowId, seq])` 兜底（会抛 P2002），要不要改成显式的行锁 / 序列。
