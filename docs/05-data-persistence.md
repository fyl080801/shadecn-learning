# REQ-DATA 数据存储与业务 API

> 状态：**部分实现** —— 鉴权与画布数据已落库（SQLite / PostgreSQL 二选一）；业务数据（notes）仍是内存实现，作为 API 形态的样板。

## 1. 目标

默认给应用一个**零外部依赖**的持久层：不需要单独部署数据库服务，一个文件即全部状态，同时保证 CLI（prisma 命令）和服务端进程永远打开同一个库。

同时留出**换成 PostgreSQL** 的口子：需要多副本、需要真正的并发写、或者公司里本来就有 PG 时，改两个环境变量就能切过去，业务代码一行不动。

## 2. 选型约束

| 选择 | 理由 |
|---|---|
| SQLite（默认） | 单文件、无需额外服务；配合 PVC 就能在 k8s 上跑 |
| PostgreSQL（可选） | 需要多副本 / 并发写 / 外部托管库时切过去 |
| Prisma 7 | 类型安全的 client + 一条命令同步结构；7.x 强制要求 driver adapter |
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

> 这条一致性是硬要求：CLI 和服务端运行时必须操作同一个库，否则会出现「db push 推了但服务端说表不存在」。

### 3.3 一份模型，两个 provider（多文件 schema + 符号链接）

两份 schema 是躲不掉的：Prisma 的 `datasource.provider` **只接受字面量** —— `env()` 被明确禁止
（[prisma#998](https://github.com/prisma/prisma/issues/998)），2.2 那个 `provider = ["sqlite", "postgresql"]`
的数组写法已经废弃（[prisma#3834](https://github.com/prisma/prisma/issues/3834)），
"让 provider 动态化"的诉求（[prisma#1487](https://github.com/prisma/prisma/issues/1487)）也已关闭。
一份 schema 还只能有一个 datasource。**但模型可以只有一份物理文件**，靠多文件 schema：

```
prisma/
  models/                  ← 唯一的手写来源，按域拆：auth.prisma / canvas.prisma
  sqlite/
    schema.prisma          ← 只有 generator + datasource { provider = "sqlite" }
    models -> ../models    ← 符号链接
  postgresql/
    schema.prisma          ← 同上，只有 provider 那行不同
    models -> ../models    ← 符号链接
```

`prisma.config.ts` 的 `schema` 指向**目录**（`prisma/<provider>`），Prisma 把目录下所有 `.prisma`
合并成一份完整 schema。于是两个 provider 的差别**只剩 datasource 里的一行**。

**没有生成物，也就没有漂移。** 以前是 `models.prisma` + 一个生成脚本吐出两份完整 schema，
还得有 `db:schema:check` 在 `build:server` 前守着别漂；现在两份 schema 就是手写的十来行，
模型是同一批文件，生成脚本和守卫都删了。

几个要点：

- **Prisma 7 不允许 datasource 里写 `url`**（报 P1012，连接串必须放 `prisma.config.ts`），
  所以 datasource block 里就只剩 `provider` 一行 —— 这也是两份 schema 差异能缩到一行的原因。
- **generator 必须在 `--schema` 指定目录的 `schema.prisma` 里**，不能放进 `models/`，
  所以那 4 行在两边各写一份。
- 模型里**不许出现 provider 专属的东西**（`@db.*` 原生类型、数组、`Json`、enum…），
  两边生成的 client 类型必须一模一样 —— 这是业务代码不用分叉的前提。
  `roles` / `tags` 这类字段统一用 `String` 存 JSON 字符串。
- **依赖符号链接**，所以不考虑原生 Windows（要在 Windows 上开发就用开发容器 / WSL）。
  容器构建没问题：`COPY prisma ./prisma` 会原样保留相对链接，实测容器里
  `readlink -f` 两个 provider 的 `models` 都指到同一个 `/app/prisma/models`。
- **构建产物是例外**：`scripts/build-server.mjs` 拷 schema 目录时用 `dereference: true`
  把链接解成真实文件（产物里是 `prisma/schema.prisma` + `prisma/models/*.prisma`），
  否则产物里那条 `../models` 会指向 `output/prisma/../models` —— 那儿什么都没有。
- **产物侧 `prisma.config.js` 的 `schema` 同样必须指向目录**。这里踩过一次：指到
  `prisma/schema.prisma` 那个文件时，Prisma 只读那一个文件、一个 model 都看不到，
  于是 `db push` 认为「schema 是空的，库也是空的，已经一致」，建出一个 **0 字节的空库**
  还报 `already in sync`，一张表都没有 —— 等服务起来才发现。

> 横向对照：Drizzle 也**故意**不做「一套定义多方言」（`pgTable` / `sqliteTable` 分开），
> 理由和上面一样 —— 方言能力不同，统一 builder 就得降到最小公分母。
> 所以这不是 Prisma 的缺陷，而是这一类工具的共识。

### 3.3.1 结构同步：`prisma db push`，**没有迁移文件**

**这个项目不留迁移历史。** 没有 `prisma/migrations/`，库里没有 `_prisma_migrations` 表，
`prisma.config.ts` 也不配 `migrations.path`。建表 / 改表就一条命令：

```bash
pnpm db:push        # = prisma db push（schema 目录由 prisma.config.ts 按 provider 选）
```

开发、测试、容器启动走的是**同一条路径**：`pnpm dev` 先 `db:push` 再起服务，
容器的 `CMD` 是 `npx prisma db push && node server/index.js`。

**为什么不用迁移文件。** 迁移这条路在两个 provider 下**必然要写两份**，而且不是措辞不同、是结构不同：

- `migration.sql` 是纯文本 DDL，按 datasource 的 provider 生成，运行时不做方言转换；
- 每个迁移目录的 `migration_lock.toml` 锁着 provider，混用会被 Prisma 直接拒绝，
  所以两种库必然是两个目录、两套历史、条条对应；
- 方言真的不一样：`BLOB`/`BYTEA`、`DATETIME`/`TIMESTAMP(3)`、内联外键 vs 独立的
  `ALTER TABLE ADD CONSTRAINT`，而且 **SQLite 不支持改列/删列** —— 同一次「删 5 列加 1 列」的变更，
  PG 是一条 `ALTER TABLE`，SQLite 得整表重建（建 `new_` 表 → 搬数据 → `DROP` → `RENAME`）。

这套双份历史的维护成本，只有在需要**照顾存量数据**时才划得来。这个项目是学习/实验性质的，
没有要升级的生产数据，所以选了 db push：`prisma/models/` 是唯一的结构来源，
改完推一下就行，两种库天然一致。

**代价，写在这儿别忘了：**

- **没有结构变更的历史**，也就没有「这张表什么时候加的列」可查，更没有回滚脚本；
- **破坏性变更需要人工确认**。db push 遇到要删列删表时会拒绝执行，除非加 `--accept-data-loss`。
  两个 Dockerfile 和产物的 `db:push` 脚本**故意不带**这个 flag —— 宁可容器启动失败、
  让人来看一眼，也不要在生产库上静默丢数据。
  **开发期的出口是 `pnpm db:push:force`**（就是带上这个 flag 的 `db push`）：本地库里是随时能重造的
  测试数据，为了改个字段名去手写 DDL 不值得。它是**单独一条命令，不挂在 `pnpm dev` 上** ——
  `dev` / `dev:cluster` 走的仍是不带 flag 的 `db:push`，否则每次启动开发服务器都可能悄悄删掉一列，
  而那正是这道闸要拦的事。生产库上仍然只有手动跑 `npx prisma db push --accept-data-loss` 这一条路，
  跑之前先按 [REQ-DEPLOY §3.6](12-deployment.md) 看一眼 DDL；
- 因此**生产升级前要自己判断这次模型改动是不是破坏性的**。加表加列是安全的，改名/改类型/删字段不是。

### 3.4 两种库的行为差异

只有一处需要代码补偿：**SQLite 的 `LIKE` 对 ASCII 大小写不敏感，PostgreSQL 的不是**。`server/store/text.ts` 的 `nameContains()` 在 PG 下补 `mode: 'insensitive'`（翻成 `ILIKE`），把两边的搜索结果拉齐。新增模糊搜索一律走它，别直接写 `{ contains }`。

### 3.5 数据模型

| 模型 | 用途 | 关键约束 |
|---|---|---|
| `User` | 从 Keycloak id_token / userinfo 落下来的用户档案 | `@@unique([issuer, subject])` —— 换 realm 即视为另一个人；`roles` 因 SQLite 无数组类型，存成 JSON 字符串 |
| `Session` | 服务端会话，存 access / refresh / id token | 主键是 Cookie 中随机 token 的 **HMAC-SHA256**（密钥 `SESSION_SECRET`），token 本身不落库；`userId` 建索引；随 User 级联删除 |
| `AuthRequest` | 一次授权请求的临时凭据（state / nonce / PKCE verifier / redirectTo） | `state` 唯一；回调时一次性消费；过期由定时清扫回收 |

字段级说明见 `prisma/models/*.prisma` 中的注释（`auth.prisma` / `canvas.prisma`）。

### 3.6 客户端单例

- `server/db.ts` 导出唯一的 `PrismaClient`，缓存在 `globalThis` 上，避免 `tsx watch` 每次热重启泄漏连接；adapter 按 provider **动态** import（构建产物里只留用得上的那个）。

### 3.7 命令

| 命令 | 作用 |
|---|---|
| `pnpm db:generate` | 重新生成 client（改完模型必跑；`postinstall` 也会跑） |
| `pnpm db:push` | 把表结构对齐到 schema（**没有迁移文件**，见 3.3.1）；`pnpm dev` 会先跑一遍 |
| `pnpm db:studio` | 可视化查看数据 |

改完模型（`prisma/models/*.prisma`）的标准动作：`pnpm db:generate`（client）+ `pnpm db:push`（库结构）。两种库各自 push 一次，
用的是同一批 `prisma/models/` 文件，不存在「两份 schema 要对齐」这回事了。

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

- [ ] 全新克隆仓库后执行 `pnpm install && pnpm db:push`，`data/app.db` 被自动创建（含父目录）。
- [ ] 在任意子目录下执行 `pnpm db:push` 与 `pnpm dev`，两者操作的是同一个库文件。
- [ ] `pnpm prune --prod` 之后服务端仍能启动（生成的 client 未被删掉）。
- [ ] 未登录访问 `/api/notes` 返回 401。
- [ ] notes 的五个端点全部符合上表的状态码与错误格式，并有对应测试覆盖。
- [ ] 删除 `data/app.db` 后重新 `db:push` 能从零重建全部表结构。
- [ ] 两个 provider 目录下的 `models` 符号链接都指向 `prisma/models/`；`prisma validate` 在两种 DB_PROVIDER 下都通过。
- [ ] 设 `DB_PROVIDER=postgresql` + PG 的 `DATABASE_URL` 后，`pnpm db:generate && pnpm db:push && pnpm dev` 全流程可用，接口行为与 SQLite 一致。
- [ ] `TEST_DATABASE_URL=postgresql://… pnpm test:server` 整套后端测试在 PG 上同样全绿。
- [ ] `DB_PROVIDER` 与 `DATABASE_URL` 协议不一致时启动直接失败，不会连错库。

## 5. 本期不做

- 把 notes 从内存迁到 Prisma（等真正需要持久化的业务出现再做）。
- ~~软删除~~ —— 做了（`deletedAt` 过滤）。
- **审计日志 / 操作历史 / 回滚** —— 曾经有（`FlowOperation` 存每次 Yjs 更新的二进制 + 服务端认定的
  `actorId`），**已整体移除**：产品里没有任何回放或恢复入口，而这张表只增不减，是全库唯一随编辑次数
  线性增长的东西（`Flow.ydoc` 有 Yjs 的 GC 收敛，它没有）。要恢复审计，先想清楚它服务于哪个界面。
- **乐观锁** —— 曾经有（`Flow.revision` + `baseRevision`），换 CRDT 之后**主动去掉了**：
  Yjs 的更新可交换、可结合、幂等，冲突由算法收敛，再加乐观锁只会把并发编辑挡在门外。
  `revision` 字段留着，语义变成「服务端写过多少次全量状态」的计数，没有人拿它做冲突判断。
- 分页、排序、过滤参数。
- 数据库备份 / 恢复方案。
- MySQL 等第三种库（模型里就没有为它留的余地）。
- 一份产物同时支持两种库：Prisma 生成的 client 编译期就绑定了查询编译器，构建时必须定下 provider。

## 6. 待确认事项

- `notes` 是继续当纯样板，还是作为第一个真实持久化业务落库。
- SQLite 单写入者模型在协同场景下是否够用。协同**已经在落盘**了（`Flow.ydoc`），
  目前靠 `server/collab/persistence.ts` 里的按房间串行队列避开并发写，单进程下够用；
  多副本就是切 PG 的时候（Yjs 的跨进程问题已经解掉了，见 [REQ-CLUSTER](14-clustering.md)）。
- **没有任何历史了**。移除操作日志之后，误删、被移出项目的人清空画布、协作者的破坏性编辑，
  都无法恢复 —— `Y.UndoManager` 只跟踪本地来源，别人的改动进不了你的撤销栈。
  要补，正确的形态是**画布版本快照**（存 ydoc 二进制而非 JSON 投影，见 [README 的优化项](README.md)），
  不是把逐条更新流加回来。
