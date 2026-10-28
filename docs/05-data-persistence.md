# REQ-DATA 数据存储与业务 API

> 状态：**部分实现** —— 鉴权与画布数据已落库（SQLite / PostgreSQL 二选一）；业务数据（notes）仍是内存实现，作为 API 形态的样板。

## 1. 目标

默认给应用一个**零外部依赖**的持久层：不需要单独部署数据库服务，一个文件即全部状态，同时保证表结构同步入口和服务端进程永远打开同一个库。

同时留出**换成 PostgreSQL** 的口子：需要多副本、需要真正的并发写、或者公司里本来就有 PG 时，改两个环境变量就能切过去，业务代码一行不动，**构建产物也不用重新打** —— 同一个产物两种库都能连。

## 2. 选型约束

| 选择 | 理由 |
|---|---|
| SQLite（默认） | 单文件、无需额外服务；配合 PVC 就能在 k8s 上跑 |
| PostgreSQL（可选） | 需要多副本 / 并发写 / 外部托管库时切过去 |
| MikroORM 7（`@mikro-orm/core` 7.2.5，版本锁死） | 一份实体定义（`defineEntity`），驱动在运行时选；自带按实体比对库结构的 schema 生成器 |
| `@mikro-orm/sqlite`（连带 better-sqlite3）/ `@mikro-orm/postgresql`（连带 pg） | 两种库的驱动，`apps/server/db/orm.ts` 按 `DB_PROVIDER` **动态** import；两个都进构建产物 |

### 2.1 为什么从 Prisma 换成 MikroORM

Prisma 7 时代这里有一整套为「两种库」打的补丁，根子都在同一处：**Prisma 的 provider 是编译期的**。

- `datasource.provider` 只接受字面量（`env()` 被禁止，[prisma#998](https://github.com/prisma/prisma/issues/998)；数组写法已废弃，[prisma#3834](https://github.com/prisma/prisma/issues/3834)），所以要两份 schema 目录 + 一个指向共享模型的**符号链接**（于是不支持原生 Windows，产物构建还得 `dereference`）；
- 生成的 client 里编译进去的是**一种**库的查询编译器 —— **一个构建产物只能连一种库**，换库要重新 `db:generate` + 重新构建；`build:server` 得先校验 client 的 provider，测试的 global-setup 得在两种 provider 之间来回 `generate` 再还原（还原失败就会让 `pnpm dev` 撞上 `PrismaClientInitializationError`）；
- provider 解析规则写了两份（CLI 侧的 `.mjs` 和服务端的 `config.ts`），靠「改一边改另一边」维持一致；
- `nameContains()` 里那个类型断言：`mode: 'insensitive'` 只存在于 PG 版生成的 client 类型里。

MikroORM 的实体定义本来就和库无关，驱动是运行时的一个配置项。换过来之后上面这些**全部删掉**：没有生成步骤、没有符号链接、provider 解析只剩 `config.ts` 一份，一个产物两种库。

这次是**当成全新方案实施**的：不兼容 Prisma 的表结构（表名列名换成 MikroORM 默认的 `UnderscoreNamingStrategy`：`UserIdentity` → `user_identity`、`avatarUrl` → `avatar_url`），也不提供迁移脚本 —— 没有需要照顾的存量数据。

## 3. 功能需求

### 3.1 选哪种库

`DB_PROVIDER` 只接受 `sqlite` / `postgresql`。没设就按 `DATABASE_URL` 的协议推断（`file:` → sqlite，`postgres(ql)://` → postgresql），两个都没有就是 sqlite。

硬性检查（对不上直接启动失败，绝不"猜一个"继续跑）：

- `DB_PROVIDER` 是别的值 → 报错；
- `DB_PROVIDER` 和 `DATABASE_URL` 的协议不一致 → 报错；
- `DB_PROVIDER=postgresql` 却没给 `DATABASE_URL` → 报错。

它**只决定运行时加载哪个驱动**。实体定义、构建产物、镜像都和它无关。

### 3.2 数据库位置

解析规则只有一份，在 `apps/server/config.ts`（`dbProvider` / `databaseUrl`）。服务端进程和表结构同步入口（`apps/server/db/sync-cli.ts`）都从这里取：

1. 设了 `DATABASE_URL` → 直接用它，覆盖一切；
2. 否则（仅 sqlite）库文件为 `$DATA_DIR/app.db`；
3. `DATA_DIR` 默认为仓库根目录下的 `data/`（已 gitignore）；
4. 两者中的**相对路径都以仓库根目录为基准，不是 cwd**（构建产物里是进程 cwd）；
5. sqlite 打开前 `mkdir -p` 父目录 —— better-sqlite3 不会自动建目录；PG 无此步（库不存在时同步入口会自动 `create database`）。
6. PG 连接串里 Prisma 时代的 `?schema=xxx` 写法照旧认：`db/orm.ts` 把它摘出来交给 MikroORM 的 `schema` 选项（pg 本身不认这个参数）。

### 3.3 一份实体定义，两种库

实体在 `apps/server/db/entities/`（`auth.ts` / `canvas.ts`，用 `defineEntity` + `p.*` 构建器写），`index.ts` 汇总成交给 MikroORM 的列表。规矩写在 `db/entities/columns.ts` 的头注释里，每一条都是两种库上实测出来的：

| 规则 | 不这么做会怎样 |
|---|---|
| **字符串一律 `p.text()`，不用 `p.string()`** | `p.string()` 在 PG 上是 `varchar(255)`，SQLite 不限长 —— access_token、头像地址在 SQLite 上写得进去、换到 PG 才截断报错 |
| **只用五种类型**：text / integer / boolean / datetime / blob | json、enum、array、原生列类型（`columnType`）两边要么没有、要么行为不同。JSON 照旧存字符串（`roles`、`tags`、`graph`、`FlowUserState.value`） |
| **可空列用 `strictNullable()`** | `nullable()` 推出来的类型是 `T \| null \| undefined`，一路传染到接口类型上。用 `strictNullable()` 之后 `em.create` 里没给的可空字段要**显式写 `null`**（内存里的实体不会自动补），否则刚建出来就映射成接口的那条路上会是 `undefined` |
| **时刻的默认值在应用里给**（`onCreate` / `onUpdate`），不给数据库默认值 | `current_timestamp` 在两种库里的存储格式不一样 |
| **主键是应用生成的 UUID 文本**（`idColumn()`）；`Session.id` 例外，由调用方给 token 的 HMAC | 自动生成会把 HMAC 盖掉，cookie 就对不上库里的行 |
| **外键是关系属性**（`user` / `project` / `flow` …，列名 `user_id`），只定义拥有外键的那一侧 | 反向的一对多集合查询用不上，而 `defineEntity` 的类型推断遇到互相引用会退化成 `any` |
| `Flow.ydoc` / `Flow.graph` 是 **lazy** 列 | 一张画布的 ydoc 可以有 20MB；列表默认查询不取，要用的地方显式 `populate` / `fields` |

关系 / 级联 / 唯一约束 / 索引和 Prisma 时代逐一对应（`deleteRule('cascade')`、`uniques`、`indexes`）。只有一列没跟过来：`UserIdentity.emailVerified` —— 没有任何代码读写它，留着的唯一理由是「删列会让 db push 变成破坏性变更」，全新建表就没这个顾虑了。

### 3.3.1 用法上与 Prisma 的差异（易错点）

- **每次操作 fork 一个 EntityManager**：`db()`（`apps/server/db.ts`）就是 `orm.em.fork()`。不开 `allowGlobalContext`，也不用 RequestContext 中间件 —— store 层每个函数自己 fork，协同落库、定时清理这些不在请求里的路径同样能用。
- **`nativeUpdate` / `em.insert` / `em.upsert` 不触发 `onCreate` / `onUpdate`**。Prisma 的 `@updatedAt` 在 `updateMany` 里会自动带上，这里不会：用 `nativeUpdate` 改内容的地方必须显式写 `updatedAt: new Date()`（`collab/persistence.ts` 和 `collab/flow-writer.ts` 的 CAS 写尤其要紧 —— 漏了的话列表按「最近修改」排序时编辑过的画布纹丝不动）；`upsert` 建行时要自己给 `id`（`newId()`）和 `createdAt`，并用 `onConflictMergeFields` 限定撞车时改哪些列（不然 id 也会被换掉）。
- **CAS**：`em.nativeUpdate(Flow, { id, revision: 读到的 }, { revision: 读到的 + 1, … })` 返回受影响行数，0 就是被抢先了。Prisma 的 `{ increment: 1 }` 在 CAS 里本来就不能用。
- **嵌套写 / `$transaction([...])` → `em.transactional(async (em) => …)`**：回调里 `em.create` 的实体在提交时一起 flush。
- **唯一冲突统一抛 `UniqueConstraintViolationException`**（两种库一样），替代 Prisma 的 `P2002`；只在这一种错误上走「输了就重查」的分支（个人空间懒创建、关联账号、本地开发用户），别的错误照常抛。
- **不再有 `P2025`**（更新 / 删除不存在的行时 Prisma 会抛）：`nativeUpdate` / `nativeDelete` 删 0 行就返回 0。原来靠 `.catch(() => undefined)` 吞掉它的地方都改成了不吞；OAuth 回调的「一次性消费」改成**以删除成功为准**（`nativeDelete` 返回 1 的那个请求才算数），并发重放时只有一个能过。
- `include` / `select` → `populate` / `fields`；`skip` / `take` → `offset` / `limit`；`groupBy` 计数 → `em.countBy()`。

### 3.4 表结构同步：没有迁移文件，有损变更要显式放行

**这个项目不留迁移历史。** 建表 / 改表就一条命令，开发、测试、容器启动走的是**同一份代码**：

| 场景 | 命令 |
|---|---|
| 源码态 | `pnpm db:push`（= `tsx db/sync-cli.ts`）；`pnpm dev` / `pnpm dev:cluster` 先跑它 |
| 开发期放行有损变更 | `pnpm db:push:force`（= `tsx db/sync-cli.ts --force`） |
| 构建产物 / 容器 | `node server/db-sync.js`（esbuild 把 `db/sync-cli.ts` 打成的第二个入口）；容器 `CMD` 是 `node server/db-sync.js && exec node server/index.js` |
| 测试 | `apps/server/test/global-setup.ts` 在子进程里跑同一个入口（PG 测试库加 `--reset`） |

**为什么不用迁移文件。** 迁移是按方言生成的纯 DDL（`BLOB`/`BYTEA`、`datetime`/`timestamptz`、内联外键 vs 独立的 `ALTER TABLE ADD CONSTRAINT`），而且 **SQLite 不支持改列** —— 同一次「改一列类型」，PG 是一条 `ALTER TABLE`，SQLite 得整表重建。迁移文件必然两份、条条对应。这套维护成本只有在需要照顾存量数据时才划得来，而这个项目没有。

#### 3.4.1 有损变更守卫（`apps/server/db/schema-sync.ts`）

MikroORM 的 `schema.update({ safe: true })` **挡不住有损变更**（实测）：

- SQLite 上改列（改类型、改可空、改默认值）一律走「建 `<表>__temp_alter` → 拷数据 → 删原表 → 改名」的整表重建，`safe` 管不到这条路，列一变就可能搬丢；
- PostgreSQL 上 `safe` 只跳过 `drop column`，`alter column ... type` 照做不误。

所以不调 `update()`，而是：`getUpdateSchemaSQL()` 拿到**将要执行的那段 SQL** → 逐句判 → 原样交给 `schema.execute()`。判的和执行的是同一段文本，中间没有第二次比对。

| 判为有损（默认拒绝） | 放行 |
|---|---|
| 删表（`drop table`） | 建表 |
| 删列（`drop column`） | 加列 |
| 改列类型（PG 的 `alter column … type`） | 建索引、删索引 |
| SQLite 整表重建（`__temp_alter`） | 加外键 / 唯一约束 |
| 改名（`rename column` / `rename to`：MikroORM 按启发式判「删一列 + 加一列」是不是改名，判错了数据就挪到了别的列上） | 改可空 / 非空、改默认值（PG；失败了当场报错，不会悄悄丢数据） |
| 清数据（`truncate` / `delete from`，防御性） | |

拒绝时把每一句连同类别打出来，退出码 1，**一句都不执行**。`--force` 放行（相当于原来的 `--accept-data-loss`）。判据的单元测试用的是两种库**实际吐出来的** SQL 样本（`apps/server/test/db/schema-sync.test.ts`），另有一组在真实测试库上只算不执行的用例（删字段被拒、改类型被拒、加列放行、实体与库一致时差异为空）。

**模型之外的表**：默认模式下比对时不看库里那些实体里没有的表（`dropTables: false`），只在输出里列出来提醒一句。它们不归这里管，留着不碍事 —— 最典型的就是换 ORM 之前 Prisma 建的那批 `"User"` `"Session"`（大小写不同，和新表不冲突）。`--force` 才把它们算进差异，那时会连同数据一起删掉。

**代价，写在这儿别忘了：**

- **没有结构变更的历史**，也就没有「这张表什么时候加的列」可查，更没有回滚脚本；
- **破坏性变更需要人工确认**。两个 Dockerfile 和产物的 `db:push` 脚本**故意不带** `--force` —— 宁可容器启动失败、让人来看一眼，也不要在生产库上静默丢数据。开发期的出口是 `pnpm db:push:force`：它是**单独一条命令，不挂在 `pnpm dev` 上**，否则每次启动开发服务器都可能悄悄删掉一列，而那正是这道闸要拦的事。生产库上仍然只有手动跑 `node server/db-sync.js --force`（产物里 `npm run db:push:force`）这一条路，跑之前先看一眼它拒绝时打出来的语句；
- 因此**生产升级前要自己判断这次实体改动是不是破坏性的**。加表加列是安全的，改名 / 改类型 / 删字段不是；在 SQLite 上连「改成可空」都会触发整表重建、需要 `--force`。
- 多副本同时启动时，各自的同步入口会并发比对、并发执行（Prisma 时代的 `db push` 也是如此）。纯加列 / 加表的变更撞车时，后到的那个会因「已存在」报错退出，k8s 重启它一次即可。

### 3.5 两种库的行为差异

只有一处需要代码补偿：**大小写不敏感的模糊搜索**。SQLite 的 `LIKE` 对 ASCII 天生大小写不敏感，PostgreSQL 的不是；MikroORM 的 `$ilike` 又是 PG 专属，SQLite 上直接是语法错误。`apps/server/db/query.ts` 的 `containsIgnoreCase(列名, 关键字)` 统一写成 `lower(列) like lower(?) escape '\'`：两侧用同一个库的同一个函数，关键字里的 `%` `_` `\` 转义掉。新增模糊搜索一律走它（铺进 where 里，放进关系的嵌套条件里也指向正确的表），别直接写 `$like` / `$ilike`。

### 3.6 数据模型

| 实体（表） | 用途 | 关键约束 |
|---|---|---|
| `User`（`user`） | 主身份提供方落下来的用户档案 | `(issuer, subject)` 唯一；`roles` 存成 JSON 字符串 |
| `UserIdentity`（`user_identity`） | 一条登录方式 | `(provider, subject)` 唯一 —— 关联冲突检测的全部依据；随 User 级联删除 |
| `Session`（`session`） | 服务端会话，存 access / refresh / id token | 主键是 Cookie 中随机 token 的 **HMAC-SHA256**（密钥 `SESSION_SECRET`），token 本身不落库；`user` 建索引；随 User 级联删除 |
| `PendingLink`（`pending_link`） | 等用户确认的账号关联 | `user` 唯一（一人一条） |
| `AuthRequest`（`auth_request`） | 一次授权请求的临时凭据（state / nonce / PKCE verifier / redirectTo） | `state` 唯一；回调时一次性消费（以删除成功为准）；过期由定时清扫回收 |
| `Project` / `ProjectMember` / `ProjectInvite` | 项目、成员、分享链接 | `personal_owner_id` 唯一；`(project, user)` 唯一；邀请的 `project` 与 `token` 各自唯一 |
| `Flow`（`flow`） | 一张画布 | `ydoc`（blob，内容的事实源）+ `graph`（只读投影）；`revision` 是写计数，落库时拿它做 CAS |
| `FlowUserState`（`flow_user_state`） | 每人一份的画布视图状态 | `(flow, user, key)` 唯一 |

字段级说明见 `apps/server/db/entities/*.ts` 中的注释。

### 3.7 ORM 单例与日志

- `apps/server/db.ts` 导出唯一的 `orm`（模块顶层 `await createOrm()`，缓存在 `globalThis` 上，避免 `tsx watch` 每次热重启泄漏连接）和 `db()`（fork）。`MikroORM.init()` 只做实体发现、**不连库**，第一条查询才建连接 —— 数据库不通时进程照样起得来，readiness 如实报 not-ready。
- 驱动**动态** import：连 PG 的进程不会加载 better-sqlite3 的原生模块，反之亦然。
- 日志走 MikroORM 的 `loggerFactory`（`apps/server/logger/db.ts`），只记 SQL 文本、耗时、行数，**不记参数值**：`query-params` 命名空间永远关着（MikroORM 只在它开着时才把参数拼进交给 logger 的 SQL），`logQuery` 也只挑那几个字段用。慢查询阈值照旧是 `LOG_SLOW_QUERY_MS`。

### 3.8 命令

| 命令 | 作用 |
|---|---|
| `pnpm db:push` | 把表结构对齐到实体定义（**没有迁移文件**，见 3.4）；有损变更拒绝执行；`pnpm dev` 会先跑一遍 |
| `pnpm db:push:force` | 同上，但放行有损变更、并删掉实体之外的表。**只在开发期用** |

改完实体（`apps/server/db/entities/*.ts`）的标准动作就是 `pnpm db:push`，没有生成步骤。

Prisma 时代的 `db:generate`（没有生成物了）和 `db:studio`（MikroORM 没有等价的可视化工具）**已删除**；看数据用各库自己的客户端（`sqlite3 data/app.db`、`psql`）。

### 3.9 业务 API 样板：`/api/notes`

当前是内存 `Map` 实现（`apps/server/store/notes.ts`），进程重启即清空，启动时预置两条示例数据。它的价值是定义**业务路由应该长什么样**：

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

分层要求：**路由层只做参数校验和状态码，数据访问全在 `store/` 里**。把内存实现换成数据库时，路由文件不应有任何改动。

## 4. 验收标准

- [ ] 全新克隆仓库后执行 `pnpm install && pnpm db:push`，`data/app.db` 被自动创建（含父目录）。
- [ ] 在任意子目录下执行 `pnpm db:push` 与 `pnpm dev`，两者操作的是同一个库文件。
- [ ] 未登录访问 `/api/notes` 返回 401。
- [ ] notes 的五个端点全部符合上表的状态码与错误格式，并有对应测试覆盖。
- [ ] 删除 `data/app.db` 后重新 `db:push` 能从零重建全部表结构；紧接着再跑一次输出「无需变更」。
- [ ] 设 `DB_PROVIDER=postgresql` + PG 的 `DATABASE_URL` 后，`pnpm db:push && pnpm dev` 全流程可用，接口行为与 SQLite 一致。
- [ ] **同一份 `pnpm build` 产物**，`node server/db-sync.js && node server/index.js` 分别指向 SQLite 和 PostgreSQL 都能起来，`/api/health/ready` 为 200。
- [ ] 实体上删一个字段：`pnpm db:push` 拒绝执行并打出 `drop column` 那一句，`pnpm db:push:force` 执行。
- [ ] `TEST_DATABASE_URL=postgresql://… pnpm test:server` 整套后端测试在 PG 上同样全绿。
- [ ] `DB_PROVIDER` 与 `DATABASE_URL` 协议不一致时启动直接失败，不会连错库。

## 5. 本期不做

- 把 notes 从内存迁到数据库（等真正需要持久化的业务出现再做）。
- ~~软删除~~ —— 做了（`deletedAt` 过滤）。
- **审计日志 / 操作历史 / 回滚** —— 曾经有（`FlowOperation` 存每次 Yjs 更新的二进制 + 服务端认定的
  `actorId`），**已整体移除**：产品里没有任何回放或恢复入口，而这张表只增不减，是全库唯一随编辑次数
  线性增长的东西（`Flow.ydoc` 有 Yjs 的 GC 收敛，它没有）。要恢复审计，先想清楚它服务于哪个界面。
- **乐观锁** —— 曾经有（`Flow.revision` + `baseRevision`），换 CRDT 之后**主动去掉了**：
  Yjs 的更新可交换、可结合、幂等，冲突由算法收敛，再加乐观锁只会把并发编辑挡在门外。
  `revision` 字段留着，语义变成「服务端写过多少次全量状态」的计数；它唯一的用途是服务端自己
  落库时的 CAS（防多副本互相整段覆盖，见 [REQ-RESILIENCE](19-collab-resilience.md)），客户端看不到它。
- 分页、排序、过滤参数。
- 数据库备份 / 恢复方案。
- MySQL 等第三种库（实体规则只按 SQLite / PostgreSQL 的交集定，比如 text 主键在 MySQL 上就不成立）。
- 从 Prisma 表结构迁移数据：换 ORM 时按全新方案实施，没有存量数据要搬。

## 6. 待确认事项

- `notes` 是继续当纯样板，还是作为第一个真实持久化业务落库。
- SQLite 单写入者模型在协同场景下是否够用。协同**已经在落盘**了（`Flow.ydoc`），
  目前靠 `apps/server/collab/persistence.ts` 里的按房间串行队列避开并发写，单进程下够用；
  多副本就是切 PG 的时候（Yjs 的跨进程问题已经解掉了，见 [REQ-CLUSTER](14-clustering.md)）。
- **没有任何历史了**。移除操作日志之后，误删、被移出项目的人清空画布、协作者的破坏性编辑，
  都无法恢复 —— `Y.UndoManager` 只跟踪本地来源，别人的改动进不了你的撤销栈。
  要补，正确的形态是**画布版本快照**（存 ydoc 二进制而非 JSON 投影，见 [README 的优化项](README.md)），
  不是把逐条更新流加回来。
