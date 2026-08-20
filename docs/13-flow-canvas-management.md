# REQ-CANVAS 项目、画布管理与操作历史

> 状态：**已实现** —— 后端（6 张表 + 三组路由 + 权限中间件）、Pinia store、四个页面均已落地，测试覆盖见第 5 节。
>
> 前置：[REQ-FLOW](09-flow-chart.md) 已经验证了 Vue Flow 的交互定制（滚轮手感、自定义节点、连线）。本需求接着往上叠**项目 + 多画布 + 持久化 + 操作历史**，`/vue-flow` 那个单页 demo 变成「打开某一张画布」的编辑器形态。
>
> ⚠️ **本文经过一次大改：画布内容改由 Yjs 承载**（[REQ-COLLAB](04-realtime-collab.md)）。
> 最初这里设计的是「前端攒操作 → 防抖 `POST /commit` → 服务端按 `baseRevision` 乐观锁 → 覆盖 graph 快照」，
> 单编辑者假设下够用；上了实时协同之后那套整个作废 —— **画布内容就是一个 Y.Doc**，
> 没有提交、没有 revision 冲突、没有 409、没有「未保存」。下面凡是讲内容读写的地方
> 都已按现状重写，被替掉的旧设计在对应小节里留了一句「原本是什么、为什么不成立了」。
> 项目 / 成员 / 分享链接 / 画布增删改查这几块**不受影响**，从头到尾没变过。

## 1. 目标

1. 引入**项目**作为画布的上一层容器：项目管成员，成员身份决定画布的访问权。
2. 加入项目的**唯一方式是分享链接**：一个项目一条、不限使用人数，管理员打开分享面板即拿到；创建者即管理员。
3. 一个项目里能存在**多张画布**，由数据库维护；列表分页展示，可新建 / 重命名 / 复制 / 删除 / 打开。
4. 画布内容住在一个 **Y.Doc** 里，Pinia store 只是它的响应式投影；撤销 / 重做由 `Y.UndoManager` 提供，且**只撤自己的**。
5. 每一次更新**同时写库**：服务端订阅同一个文档，既让「刷新页面内容不丢」成立，也留下审计 / 回放的可能。
6. 数据结构从第一天起就为扩展留口子：节点除了 Vue Flow 的布局字段外，还有一块**自定义业务数据**；数据库统一按 **JSON 字符串**存，加字段不用迁移。

## 2. 名词

| 名词 | 含义 |
|---|---|
| 项目 / Project | 画布的容器与权限边界，成员的集合 |
| 成员 / Member | 项目内的一个用户，角色为管理员或普通成员 |
| 分享链接 / Invite | 一个带随机 token 的链接，是加入项目的唯一入口；一个项目只有一条 |
| 画布 / Flow | 一张图，列表里的一行，编辑器里的一个文档 |
| 图内容 / Graph | 画布的全量内容：`nodes` + `edges` + `viewport`。现在它是 **Y.Doc 的只读投影**，不再是事实源 |
| 文档 / Y.Doc | 画布内容的唯一事实源，形状见 `src/lib/flow-doc.ts`（服务端镜像在 `server/collab/flow-doc.ts`） |
| 更新 / Update | Yjs 的一段增量二进制。它是可交换、可结合、幂等的 —— 这正是不需要乐观锁的原因 |
| 事务 / Transaction | 一次 `Y.Doc.transact()`。带 `LOCAL_ORIGIN` 的才进撤销栈，别人同步过来的不进 |
| 修订号 / revision | 服务端写过多少次全量状态的计数。**不是乐观锁**，没有人拿它做冲突判断 |

## 3. 数据结构设计

### 3.1 项目（`ProjectSummary`）

```ts
interface ProjectSummary {
  id: string                    // cuid
  name: string                  // 1..80 字符
  description: string | null
  memberCount: number           // 冗余统计
  flowCount: number             // 冗余统计，不含软删的
  /** 当前请求者在这个项目里的角色，由服务端按 session 填充 */
  myRole: 'admin' | 'member'
  createdById: string
  createdAt: string             // ISO 8601
  updatedAt: string
}
```

### 3.2 项目成员（`ProjectMember`）

```ts
interface ProjectMember {
  userId: string
  name: string | null           // 从 User 表带出，用于展示
  username: string | null
  email: string | null
  avatarUrl: string | null
  role: 'admin' | 'member'
  joinedAt: string
  /** 通过哪条邀请进来的；创建者为 null */
  invitedById: string | null
}
```

角色只有两级，本期不做自定义角色：

- **admin** —— 创建者自动获得。能改项目名/描述、看与重置分享链接、移除成员、删除项目，以及 member 的全部能力。
- **member** —— 能看项目、看成员列表、对项目内画布做全部增删改。

### 3.3 分享链接（`ProjectInvite`）

**一个项目只有一条**（`projectId` 唯一），**不限使用人数**，唯一的失效闸是 `expiresAt`。管理员打开分享面板即拿到链接 —— 没有「生成」这一步；链接发漏了就「重置」，原地换 token，旧链接立刻查不到。

```ts
interface ProjectInvite {
  id: string
  projectId: string             // 唯一：一个项目一条
  /** 32 字节随机数的 URL-safe base64，链接形如 /invite/<token> */
  token: string
  /** 接受后获得的角色，本期恒为 'member' */
  role: 'member'
  createdById: string
  createdAt: string
  expiresAt: string             // 默认创建后 7 天
}
```

**未登录用户点开分享链接是可用的**：`/invite/<token>` 是普通页面路径，会被 `server/frontend/guard.ts` 拦下并 302 到 `/login?redirect=/invite/<token>`，登录完自动跳回，落在「确认加入」界面上。这条路径不需要额外开白名单。

### 3.4 画布列表项（`FlowSummary`）

列表页只要摘要，**不带 graph**（图内容可能很大，列表接口绝不返回）。

```ts
interface FlowSummary {
  id: string                    // cuid
  projectId: string             // 归属项目，创建后不可改
  name: string                  // 画布名，必填，trim 后 1..80 字符
  description: string | null
  status: 'draft' | 'published' | 'archived'
  tags: string[]                // 标签，DB 里存 JSON 字符串
  thumbnail: string | null      // 预览图，本期恒为 null
  nodeCount: number             // 冗余统计，列表直接展示；服务端写状态时一并派生
  edgeCount: number
  revision: number              // 服务端写过多少次全量状态；只是个计数，不做乐观锁
  createdById: string           // 创建者，仅用于展示，不用于鉴权
  createdAt: string
  updatedAt: string
}
```

> 注意：画布的访问权来自**项目成员身份**，不是 `createdById`。同项目内成员之间平权，谁建的都能改。

### 3.5 画布详情（`FlowDetail`）

```ts
interface FlowDetail extends FlowSummary {
  /** Y.Doc 的只读投影，**编辑器不读它**；见 3.6 */
  graph: FlowGraph
  /** 请求者自己的视图状态，见 3.5.1；没存过的分区不出现 */
  userState: FlowUserState
}
```

> 编辑器进页面时仍然调 `GET /api/flows/:id`，但要的只是 `meta`（名字、状态、我的角色…）和 `userState`。
> **内容不从这里来** —— 它来自 `flow:<id>` 房间的 WebSocket 首次同步。

#### 3.5.1 按用户存的视图状态（`FlowUserState`）

**画布上的东西分两类，走两条完全不同的路：**

| | 画布数据（内容） | 视图状态（我怎么看） |
|---|---|---|
| 例子 | 增删节点、连线、改配置、移动节点 | 平移画布、缩放 |
| 谁的 | 全项目共享，一份 | **每人一份** |
| 走什么通道 | WebSocket（Yjs） | HTTP |
| 存哪 | `Flow.ydoc`（事实源）+ `FlowOperation` 更新流 | `FlowUserState`，每人一行 |
| 广播给别人 | 是 | **否** —— 别人拖一下画布不该把我的视野也挪走 |
| 进撤销历史 | 是（`Y.UndoManager`，只撤自己的） | **否** —— 撤销不该把视野拽回去 |
| 冲突 | 不存在，CRDT 合并 | 不存在，各存各的 |
| 怎么触发 | `store.mutate(change, label)`，改动即刻广播 | `store.setViewport()` **只攒不发**，搭下一次本地编辑（或离开）的车 `PATCH /user-state` |

```ts
/** 扩展点：加一种按用户存的东西 = 加一个可选字段，表结构不动 */
interface FlowUserState {
  viewport?: { x: number; y: number; zoom: number }
  // 以后：面板宽度、折叠了哪些节点、个人偏好…
}
```

加一个分区要动三处、都不改表：`src/types/flow.ts` 的 `FlowUserState` 加字段、服务端 `server/store/flow-types.ts` 的 `FLOW_USER_STATE_PARSERS` 加一条校验（**不认识的 key 一律 400** —— 这张表不是任意 KV）、前端 `store.setUserState('新字段', 值)`（攒批、失败重试、离开前落库都是现成的）。

**视图状态自己不发请求。** `setUserState` 只把值记在本地队列里，真正落库由 `noteLocalEdit()` 触发 —— 每次本地编辑（`mutate` / `undo` / `redo`）都会叫它一声，节奏是**先立刻发一次，再防抖收尾**：空闲之后的第一次编辑当场就走（leading，不等窗口），这之后的改动交给 `useDebounceFn`，手停下来 `USER_STATE_FLUSH_DELAY`（2s）补齐最后的状态，一直不停手则由 `maxWait`（`USER_STATE_FLUSH_MAX_WAIT`，10s）顶上去。于是：只看不改的一次访问**零写流量**；一串连续操作合成开头一发加收尾一发；**没有哪次改动被丢掉**。纯防抖不行是因为它有滞后（手不停就一直不发，而这趟还兼着会话心跳，见下），纯节流又会把窗口内最后那截改动整个丢掉。只有一次编辑时收尾那发发现没东西可送，不会白跑一趟。这条设计的由来：画布内容改走 Yjs 之后，视口若还自己起定时器，它就成了整个编辑器**唯一**的周期性 HTTP 请求 —— 看一眼画布就一路 PATCH 上去。

**这一趟 PATCH 同时是会话的心跳，所以窗口到点时一定发**：视图一次都没动过的话，就把当前视口当作要存的东西发出去。内容走 WebSocket 之后编辑本身不再产生任何 HTTP，而会话的空闲计时只认真实请求，服务端的协同复验又是只读的、特意不续期（[REQ-COLLAB](04-realtime-collab.md) 4.2）—— 少了这一发，一个人可以边正常编辑边被判空闲登出。合起来是一条完整的规则：**在编辑 = 每个窗口一次 PATCH = 会话续着；只看不改 = 零请求 = 该超时就超时。**

### 3.6 图内容（`FlowGraph`）—— Y.Doc 的只读投影

```ts
interface FlowGraph {
  schemaVersion: 1                       // 结构版本，后续结构调整靠它做兼容读取
  viewport: { x: number; y: number; zoom: number }
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** 画布级自定义数据，同样透传存储 */
  meta: Record<string, unknown>
}
```

**这个形状还在，但它的地位变了。** 原本 `graph` 是画布内容的事实源，客户端算好整份快照 `POST` 上来覆盖。
现在事实源是 `Flow.ydoc`，`graph` 由服务端在写状态时**从文档里派生**出来（`server/collab/flow-doc.ts` 的 `readGraphFromDoc`），
只服务于三件事：列表页的节点/连线计数、缩略图、将来的只读预览。**编辑器一行都不读它**，
任何写接口也都不接受它 —— 客户端手里那份始终只是某一时刻的快照，拿它覆盖就会抹掉并发的编辑。

> `graph.viewport` 只是**兜底**：某人第一次打开、还没有自己的 `userState.viewport` 时用它，之后一律用个人视口。它**不跟着谁的平移缩放走**，否则我拖一下画布就改了别人的共享数据。

**老数据的迁移就是第一次打开**：`ydoc` 为空的画布在有人进房间时，由 `bindState` 把旧的 `graph` JSON 现场灌进文档（`applyGraphToDoc`）。没有迁移脚本、没有停机窗口，没被打开过的画布原样躺着。

### 3.7 节点（`FlowNode`）—— 布局层与业务层分离

**约定：Vue Flow 认识的字段留在顶层，业务自定义的一切都塞进 `data`。** 这样换掉渲染层（或升级 Vue Flow）时业务数据不受影响，`data` 也不会被 Vue Flow 的内部字段污染。

```ts
interface FlowNode {
  // —— 布局层：直接喂给 Vue Flow ——
  id: string
  type: string                  // 注册的自定义节点组件名，如 'process'
  position: { x: number; y: number }
  width?: number                // 手动 resize 过才有
  height?: number
  zIndex?: number
  parentNode?: string           // 预留：分组 / 子流程
  extent?: 'parent' | null

  // —— 业务层：全部在 data 内 ——
  data: FlowNodeData
}

interface FlowNodeData {
  label: string                       // 节点标题
  kind: string                        // 业务种类，决定 config 的形状（如 'http' / 'script' / 'branch'）
  description?: string
  icon?: string                       // lucide 图标名
  /** 与 kind 一一对应的自定义配置。前后端都不解释它的内容，原样透传存储 */
  config: Record<string, unknown>
  /** 显式声明的输入 / 输出端口；空数组表示只用默认的单进单出 */
  ports: { inputs: FlowPort[]; outputs: FlowPort[] }
  /** UI 状态里需要持久化的部分（折叠、备注颜色…） */
  ui?: Record<string, unknown>
}

interface FlowPort {
  id: string                    // 对应 Vue Flow Handle 的 id
  label?: string
  /** 数据类型标记，用于将来做连线合法性校验；本期只存不校验 */
  dataType?: string
}
```

**运行时状态不落库**：`selected` / `dragging` / `dimensions`（自动测量出来的尺寸）/ 校验结果 / 执行态，这些由 Vue Flow 或前端自己维护，序列化时必须剔除。

### 3.8 边（`FlowEdge`）

```ts
interface FlowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
  type?: string                 // 'default'（贝塞尔曲线），渲染时统一按曲线走
  animated?: boolean
  label?: string
  data: {
    kind?: string
    condition?: unknown         // 预留：分支条件
    config: Record<string, unknown>
  }
}
```

### 3.9 操作日志（`FlowOperation`）—— 只追加的 Yjs 更新流

> **原本这里是一套自定义操作模型**：`FlowOp { type, targetId, before, after }` + `FlowTransaction`，
> 每条操作自带逆操作，撤销靠 `before`/`after` 互换后重放，前端有一张 `commands/` 注册表按 `type` 查表执行。
> Yjs 接管之后这一整套都没有了 —— 撤销是 `Y.UndoManager` 的事，它自己知道怎么逆；
> 语义化的 `type` 也不再需要，因为服务端不重放操作、只存字节。`src/stores/flow/commands/` 与 `registry.ts` 已删除。

现在一条记录 = 客户端的一次 Yjs 事务，存的是**那一次更新的二进制**：

```ts
/** GET /api/flows/:id/operations 返回的一条；update 二进制本身不出接口 */
interface FlowOperationView {
  id: string
  seq: number                 // 画布内自增，从 1 开始
  actorId: string | null      // 谁改的
  serverTs: number            // 服务端收到的时刻，UTC epoch 毫秒
  size: number                // 这次更新的字节数
}
```

- **`actorId` 是这张表存在的第二个理由**。Yjs 自己只认 `clientID`（一个随机数），不知道那是谁；`actorId` 由服务端在 **WebSocket 握手**时从会话里认出来（`server/auth/ws.ts` 把它交给 `setupWSConnection`），客户端伪造不了。想知道「这个节点是谁加的」只能问这张表。
- **按 seq 顺序把 `update` 依次 `Y.applyUpdate` 到一个空文档，就能重建任意时刻的画布** —— 回放 / 历史版本预览的地基已经在了，界面还没做。
- `update` 字节不出接口：它对界面毫无用处，真要回放是服务端的事。
- 时间是 **UTC epoch 毫秒的整数**（`serverTs`，Prisma 里是 `BigInt`），不是 ISO 字符串。数值直接比大小，不受时区和格式影响；展示层才本地化（前端统一走 `src/lib/format.ts`）。**客户端的钟根本不参与** —— 时间戳在更新到达服务端的那一刻就盖（特意在进写队列**之前**，否则记下的是「什么时候轮到它写」）。**但排序用 `seq`，不是 `serverTs`**：多副本下两个实例各有一个钟，见 [REQ-CLUSTER](14-clustering.md) §3.3。
- **多副本下审计只由收到客户端消息的那个实例记**：同一条更新会经 Redis 转发到每个持有该房间的实例，都记就成了实例数的倍数。判据见 `shouldRecordUpdate`。
- 客户端生成的 id（节点 / 连线）统一走 `src/lib/id.ts` 的 `createId(prefix)`，形如 `<前缀>_<时间戳 base36>_<随机段>`。随机段不能省：两个客户端可能在同一毫秒各加一个节点，只靠时间戳会撞出同一个 id，在 CRDT 里就会被合并成同一个对象。
- **拖动的中间态不进日志**：一次拖拽只在 `onNodeDragStop` 提交落点，途中的位置走反馈层（awareness）。否则拖一下就是几十条更新和几十行审计。
- `viewport` 的变化**不是操作**：不进文档、不进撤销、不产生日志、不涨 `revision`，走的是 3.5.1 那条「按用户存」的路。

### 3.10 数据库模型（Prisma，新增六张表）

```prisma
/// 画布的容器与权限边界。
model Project {
  id           String    @id @default(cuid())
  name         String
  description  String?
  createdById  String
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  /// 软删除：列表默认过滤掉非 null 的行
  deletedAt    DateTime?

  createdBy User            @relation("ProjectCreator", fields: [createdById], references: [id])
  members   ProjectMember[]
  invites   ProjectInvite[]
  flows     Flow[]

  @@index([deletedAt])
}

/// 项目成员。一个用户在一个项目里最多一条。
model ProjectMember {
  id          String   @id @default(cuid())
  projectId   String
  userId      String
  /// admin | member
  role        String   @default("member")
  /// 通过哪个用户的邀请进来的；创建者为 null
  invitedById String?
  joinedAt    DateTime @default(now())

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([projectId, userId])
  @@index([userId])
}

/// 分享链接，一个项目一条。token 明文存储 —— 它本身就是要发给别人的凭据；
/// 不限使用次数，唯一的闸是 expiresAt，重置就是原地换 token。
model ProjectInvite {
  id          String   @id @default(cuid())
  projectId   String   @unique
  token       String   @unique
  role        String   @default("member")
  createdById String
  createdAt   DateTime @default(now())
  expiresAt   DateTime

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
}

/// 一张画布。内容的事实源是 ydoc，graph 是它的只读投影，更新流在 FlowOperation 里。
model Flow {
  id          String    @id @default(cuid())
  projectId   String
  name        String
  description String?
  status      String    @default("draft")   // draft | published | archived
  /// 标签，JSON 字符串数组（SQLite 无数组类型）
  tags        String    @default("[]")
  thumbnail   String?
  /// **画布内容的唯一事实源**：Yjs 文档状态（Y.encodeStateAsUpdate 的二进制）。
  /// 为空表示还没被 Yjs 接管过，此时从下面的 graph JSON 现场构建（老数据的迁移入口）。
  ydoc        Bytes?
  /// ydoc 的**只读投影**，服务端写状态时派生。列表计数、缩略图、将来的只读预览读它，编辑器不读。
  graph       String    @default("{}")
  /// 冗余统计，列表直接展示；和 graph 一起派生
  nodeCount   Int       @default(0)
  edgeCount   Int       @default(0)
  /// 服务端写入 ydoc 的次数。CRDT 不需要乐观锁，这里只是个给缓存/展示用的单调计数
  revision    Int       @default(0)
  createdById String
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  /// 软删除：列表默认过滤掉非 null 的行
  deletedAt   DateTime?

  project    Project         @relation(fields: [projectId], references: [id], onDelete: Cascade)
  operations FlowOperation[]
  userStates FlowUserState[]

  @@index([projectId, deletedAt, updatedAt])
}

/// 画布上「属于某个人」的视图状态：视口，以后还有面板开合、个人偏好…
/// 按 key 分区存 JSON 字符串 —— 加一种要存的东西 = 加一个 key，不用改表。
/// 合法的 key 与各自的校验在 server/store/flow-types.ts 的 FLOW_USER_STATE_PARSERS。
model FlowUserState {
  id        String   @id @default(cuid())
  flowId    String
  userId    String
  /// 状态分区名，例如 viewport
  key       String
  /// 该分区的值，JSON 字符串
  value     String
  updatedAt DateTime @updatedAt

  flow Flow @relation(fields: [flowId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([flowId, userId, key])
  @@index([userId])
}

/// 更新流，只追加、不修改、不删除（删画布时级联）。
model FlowOperation {
  id       String @id @default(cuid())
  flowId   String
  /// 画布内自增序号，从 1 开始
  seq      Int
  /// Yjs 增量更新的二进制
  update   Bytes
  /// 发出这次更新的登录用户；服务端在 WebSocket 握手时认的，客户端伪造不了
  actorId  String?
  /// 服务端收到的时刻（UTC epoch ms）
  serverTs BigInt

  flow Flow @relation(fields: [flowId], references: [id], onDelete: Cascade)

  @@unique([flowId, seq])
  @@index([flowId, seq])
}
```

> 这张表原本有 `txId`（提交重试的幂等键）、`kind`（do/undo/redo）、`label`、`ops`（FlowOp[] 的 JSON）、`clientTs`。
> 五个字段全部删除：幂等由 Yjs 更新本身的幂等性提供（同一条 update 应用两次不会有第二个节点），
> 撤销不再是「一条新记录」而是 `UndoManager` 生成的又一次普通更新，语义化的 label 服务端用不上。

`User` 上要补两条反向关系：`memberships ProjectMember[]` 与 `createdProjects Project[] @relation("ProjectCreator")`。

**为什么状态 + 更新流双写**：只有更新流则打开画布要重放全部历史；只有全量状态则没有审计、也不知道每段改动是谁做的。二者都写 —— 进房间读全量状态（O(1)），更新流作为可回放、可追责的旁路。写入时机在 [REQ-COLLAB §3.7](04-realtime-collab.md)：每条更新即时进 `FlowOperation`，全量状态则是散场 + 10 秒防抖 + SIGTERM 三个点。

## 4. 功能需求

### 4.1 项目列表页（`/projects`）

- 应用的落地页，卡片或表格形态都行，展示：项目名、描述、成员数、画布数、我的角色、更新时间。
- 分页：默认每页 20；页码写进 URL query。
- 只列出**我是成员**的项目 —— 没有「所有项目」视图，也没有公开项目。
- 顶部「新建项目」：填名称后创建，创建者自动成为该项目的 admin 成员（`ProjectMember` 里要真实写入这一行，不能靠 `createdById` 隐式推断，否则成员列表和权限判断得处处特判）。
- 空态要给出引导：「你还没有项目 —— 新建一个，或让同事把邀请链接发给你」。
- 个人画布（[REQ-SOLO](16-personal-flow.md)）在这一页用 Tab 与项目并列：「项目」列项目、「个人画布」直接列画布。个人空间本身是一个 `kind='personal'` 的项目，但**不出现在项目列表里**。

### 4.2 项目主页（`/projects/:id`）—— 一个界面统一展现

**不做多页面**。进入项目后就一个界面：固定的项目头部 + 下方**同页 Tab**（`画布` / `成员`）。**Tab 切换不改变路由**，也不触发页面级 loading —— 两个 Tab 的数据在进入项目时就各自请求好，切换只是显隐。

**项目头部**（常驻，不随 Tab 切换）
- 项目名与描述；admin 可就地编辑。
- 右侧操作：`分享`（仅 admin）、`删除项目`（仅 admin，二次确认，软删）。

**Tab 1 · 画布**（默认选中）
- 表格形态的 listview，列：名称、描述、状态、节点/连线数、创建者、更新时间、操作。
- **分页**：默认每页 20，可选 10 / 20 / 50；显示总数与页码；页码与关键字写进 URL query，刷新/分享保持不变。
- 关键字搜索：按 `name` 模糊匹配，输入防抖 300ms。
- 排序：默认 `updatedAt desc`，支持切到 `createdAt` / `name`。
- 行操作：打开、重命名、复制一份、删除（软删，二次确认）。
- 顶部「新建画布」：填名称后创建，成功直接进编辑器。
- 空态、加载骨架、请求失败的重试入口都要有。

**Tab 2 · 成员**
- 成员列表：头像、名字、邮箱、角色、加入时间。**所有成员都能看**，不只是 admin。
- admin 额外看到：每行的「移除」按钮（不能移除自己）、以及项目头部的分享入口。
- 分享面板（admin 打开的对话框，不是新页面）：**打开即有链接**，主体就是「只读链接输入框 + 复制」；底部一行脚注放有效期（1 天 / 7 天 / 30 天，默认 7 天）、过期时间和「重置链接」。
- 改有效期**不换 token** —— 已经发出去的链接不该因为续期而失效；「重置链接」才换 token，二次确认后旧链接立刻失效。

### 4.3 分享与加入（`/invite/:token`）

- 页面先调 `GET /api/invites/:token` 预览：显示「你被邀请加入 **XXX 项目**（N 位成员）」+ `加入` / `取消` 两个按钮。**不做点开即加入** —— 用户得看清楚自己要进哪儿。
- 未登录时由页面网关 302 到登录，登录后自动跳回本页（见 3.3）。
- 点「加入」→ `POST /api/invites/:token/accept` → 成功后跳到 `/projects/:id`。
- 各种失效状态给出明确文案，不要一律「链接无效」：已过期、链接无效或已被重置、项目已删除、成员数已满。
- **已经是成员**时：预览接口直接告知，按钮变成「进入项目」，点了直接跳转（accept 接口本身也幂等，重复调用不报错、不写第二条成员记录）。

### 4.4 画布编辑器（`/flows/:id`）—— 独立整页

**从画布列表点进来是跳到一个独立页面，不套项目主页那层带菜单的外壳。** 编辑器要整块屏幕，侧边栏和项目主页的分区在这里都是干扰。

这对应用外壳（[REQ-SHELL](01-app-shell.md)）是个改动：「每个 SPA 路由都带菜单」这条约束到此为止。做法见 [REQ-SHELL 2.1](01-app-shell.md#21-整体布局) —— 带不带菜单由**模板页**区分，`/flows/:id` 挂在 `BlankLayout` 下，是第一条也是目前唯一一条不套侧栏的路由。注意这**不是**登录态的例外 —— 它依然是登录后才能进的页面，只是不带菜单。

> `AppSidebar.vue` 的布局与行为都不动 —— 只是把导航项里的「VueFlow」换成指向 `/projects` 的「画布项目」（`/vue-flow` 那个 demo 路由本身保留，只是不再挂在菜单上）。

- 进入时 `GET /api/flows/:id` 取的是**文档元信息 + 我自己的 `userState`**；画布内容随即由 `flow:<id>` 房间的首次同步送达（见 [REQ-COLLAB §4](04-realtime-collab.md)）。视口优先用 `userState.viewport`，没有才退到 `graph.viewport` 兜底，再没有就 `fitView`。
- 沿用 [REQ-FLOW](09-flow-chart.md) 的全部交互（滚轮平移、Ctrl+滚轮以光标为锚点缩放、自定义节点、连线）。
- 空白处左键的行为由底部工具栏的**指针模式**决定（框选 / 拖动画布），中键任何时候都能拖画布。此外**按住空格键**是临时的拖动手势：按住期间左键在哪按下（含节点上）都是平移画布、光标变抓手、节点暂时不可拖，松开立刻回到原来的模式 —— 模式按钮的高亮不跟着变，因为它是手势不是模式。
#### 4.4.1 悬浮胶囊工具条（左上角）

页面没有应用菜单，编辑器自己的入口收在**左上角一枚悬浮胶囊**里，浮在画布之上（圆角、半透明背景 + 模糊、与画布内容有明显层次）。从左到右三段：

1. **Logo（home）** —— 点击**返回该画布所属的项目主页**（`/projects/:projectId`）。它是这个页面唯一的「回去」入口，所以必须一眼可辨。
2. **画布名** —— 就地编辑；新建未命名时显示占位「无标题」。名字右侧跟一个克制的状态指示，不抢视线。**它指示的是「同步」不是「保存」**：`已同步` / `同步中…` / `连接断开，改动将在重连后同步`。没有「未保存」和「保存失败，点击重试」这两种状态了 —— 改动即刻广播，用户无事可做，所以断线只提示、不给按钮。
3. **菜单按钮** —— 点开下拉：

   | 菜单项 | 行为 |
   |---|---|
   | 新建画布 | 在**同一项目**下新建并直接跳过去；跳之前先 flush 攒着的视图状态（内容不用管，它一直是同步的） |
   | 复制 | 调 `duplicate`，成功后跳到副本 |
   | 删除 | 二次确认后软删，然后回到项目主页 |
   | 返回画布首页 | 回到 `/projects/:projectId`，与点 logo 等价（给一个带文字的显式出口） |

- 缩放 / 适应视图 / 锁定的控件组挪到**右上角**（[REQ-FLOW](09-flow-chart.md) 里它在左上角，这里和胶囊对调），**撤销 / 重做**也加进这一组 —— 胶囊只放「这张画布是什么、拿它怎么办」，不放画布内的编辑动作。
- **没有属性面板**：点节点不弹出任何侧栏，选中只是选中。节点的编辑入口都长在节点自己身上 —— 双击名字改名，选中时节点上方浮出工具栏（复制 / 删除）。原来那块右侧面板（label / description / config 的表单）连同「面板展开时右上角控件组左移让位」的布局一起去掉了：画布本身才是主角，为一个表单常驻挤掉三分之一画面不划算；真要编辑 `data.config` 这类结构化字段，将来按 `kind` 出**就地**的编辑形态，而不是把画布推到一边。
- **选中是「单独选中」**：点一个、拖一个、框选一片、点空白清空，全由 Vue Flow 那一份选中态说了算，我们只投影出「现在轮到哪个节点」（恰好选中一个时才有值）。所以节点工具栏同时**最多只出现一个** —— 上面的复制 / 删除都是对单个节点说的，框选一片时不出现。自己再维护一份选中态是不行的：拖动一个节点也会换选中态，而拖动之后那次 click 被 d3-drag 吞掉，于是「先点 A 再拖 B」会让两个节点头上同时挂着工具栏。

#### 4.4.2 编辑器的拆分方式

**编辑器不是一个大组件**：`FlowEditor.vue` 只负责建上下文和摆组件，功能分在两层。

- **hooks 层（`src/composables/flow/`）** —— `provideFlowEditor(props)` 建一份共享 payload 并 `provide` 出去，子组件 `useFlowEditor()` 取用，**不逐层传 props**。里面是三个各管一摊的 composable：
  | composable | 管什么 |
  |---|---|
  | `useFlowDocument` | 加载元信息、改名、新建/复制/删除、同步状态文案、离开前 flush 视图状态 |
  | `useFlowCollab` | **这一条 WebSocket 连接**：房间 `flow:<flowId>`，交出 `doc`（给 store）和 `awareness`（给 presence） |
  | `useFlowCanvas` | Vue Flow 绑定：拖动 → `store.moveNodes`、连线 → `store.addEdge`、视口同步、Ctrl+滚轮缩放、新增节点 |
  | `useFlowSelection` | 「现在轮到哪个节点」（Vue Flow 选中态的**投影**，恰好选中一个时才有值，决定节点工具栏露不露） |
  | `useFlowPresence` | 反馈层：上报光标/选中/拖动几何，读别人的 |
  | `useFlowSnapping` | 拖动时的网格 / 辅助线吸附（见 4.4.3），两者都常开、无开关、无持久化状态 |
  依赖是一条直线：`selection`/`collab` → `presence` → `canvas`，只有 `useFlowCanvas` 同时认识这三者。另有 `useFlowShortcuts(ctx)` 管快捷键和离开前的 flush。
- **组件层（`src/components/flow/`）** —— 一块界面一个组件，各自直接读上下文：`FlowCanvas`（画布本体，留了 `<slot/>` 给画布内浮层）、`FlowViewControls`（右上角控件 + 撤销/重做）、`FlowTitleCapsule`（左上角胶囊，自带删除确认）、`FlowToolbar`（底部工具栏）、`ProcessNode`（节点本体，含名字标签和选中时的复制/删除工具栏），`FlowSnapGuides`（拖动时的对齐辅助线），以及协同带来的三个：`FlowPresenceBar`（头像栏）、`FlowPresenceAvatar`、`FlowPresenceCursors`（别人的光标与正在拉的线）。

判据：**加一块新面板 / 新工具按钮，不应该需要改 `FlowEditor.vue` 或任何中间层** —— 新建组件、`useFlowEditor()` 取上下文、挂到模板上即可。
- 快捷键：`Ctrl/Cmd+Z` 撤销、`Ctrl/Cmd+Shift+Z` 重做、`Delete` / `Backspace` 删除选中。**`Ctrl/Cmd+S` 只是拦住浏览器的「保存网页」对话框**，本身不再有任何含义 —— 没有要保存的东西。
- 删除键必须自己接：Vue Flow 的 `deleteKeyCode` 在 `applyDefault: true` 下直接改它内部的 nodes/edges，绕开 store，删掉的东西既不进撤销也不同步更不落库。所以 `FlowCanvas` 传 `:delete-key-code="null"`，`canvas.deleteSelection()` 是唯一的删除路径。
- 离开页面时**没有未保存的内容可丢**，所以不再有 `beforeunload` 拦截。`onBeforeRouteLeave` 里只做一件事：把攒着的视图状态 flush 掉。

#### 4.4.3 拖动吸附：网格与辅助线

摆节点靠手是摆不齐的 —— 差两三个像素看得出来，却又懒得去调。所以拖动时同时跑两种吸附，**都没有开关，始终生效**：

| 吸附 | 行为 |
|---|---|
| **网格吸附** | 拖动时节点左上角对到背景点阵的格点上（和 `<Background>` 的 `gap` 是同一个常量 `FLOW_GRID_SIZE`，否则「吸到网格上」在画面上对不齐任何东西） |
| **辅助线吸附** | 拖动时拿自己的**左 / 中 / 右**和**上 / 中 / 下**六条线去比其他节点的同名线，进入容差就吸过去，并把对上的那条线画出来 |

- **不给开关是有意的。** 格子就是背景那圈点阵，辅助线只在真的对齐时才出现、平时完全不干预 —— 两者都是「默认就该有的手感」，一枚开关只会让人多点一下才拿到它，还得替开和关两种状态各解释一遍行为。于是也没有任何要持久化的东西：不进 Y.Doc，也不占浏览器本地存储，工具栏上一个吸附按钮都没有。

- **容差按屏幕像素算**（6px ÷ 当前缩放）。写成画布坐标的话，放大到 4 倍时磁力范围会跟着变成 4 倍，手感完全变形。
- **辅助线画在画布坐标系里**，放在 `<VueFlow>` 的 `#zoom-pane` 插槽（和别人的光标同一层），跟随缩放平移是 Vue Flow 自己的变换负责的；只有线宽和虚线疏密做反向缩放，因为它是界面不是内容。线的长度覆盖**所有**压在这条线上的节点，而不只是吸中的那一个 —— 三个节点左边对齐时，一条贯穿三者的线才说明发生了什么。
- **两种吸附同时命中时辅助线赢**：先按网格量化，再让对齐把位置拉到线上。对齐是更明确的意图，被网格拽回去反而是错的 —— 也就是说，只要吸上了辅助线，落点通常就不在格点上。
- **多选拖动按外接矩形吸附**，算出的位移原样施加到每个被拖节点，相对位置不会被拆散。
- **吸附只作用在拖动上，不去动已经摆好的节点。** 所以没有用 Vue Flow 自带的 `:snap-to-grid`：它除了拖动，还会在**节点挂载时**（`NodeWrapper` 的 `clampPosition`）把位置对到格子上 —— 那是一次只发生在本地视图、不进文档的位移，开着吸附的人和没开的人看到的画布从此不一样。两种吸附收在同一个函数（`src/lib/flow-snap.ts`，纯几何、可单测）里算，结果只有一个位移。
- 吸附发生在 `onNodeDrag` 里、Vue Flow 写完位置之后：它每帧都从**指针位置**重新算一遍节点位置，所以这一下修正不会累加到下一帧 —— 手移开对齐线，吸附自然松开。落点仍然只在 `onNodeDragStop` 一次性进文档，中间态照旧不落库（见 4.5）；上报给协作者的拖动几何是**吸附之后**的位置，否则别人看到的是没吸住的那个。

### 4.5 Pinia store（`src/stores/flow/`）

pinia 已装在 `devDependencies`（前端整体被打包进 `output/public`，服务端 runtime 不 import 它，符合仓库的依赖切分约定）。需要在 `src/main.ts` 里 `app.use(createPinia())`。

> **store 是 Y.Doc 的投影，不是内容的持有者。** 原本它是事实源：自己维护 `nodes`/`edges`、
> 两个历史栈、一个 `pending` 提交队列和 `baseRevision`。现在内容住在 Y.Doc 里，
> store 负责的是「把文档映成 Vue 能渲染的数组」和「所有写都包成一个带 origin 的 Y 事务」。
> `undoStack` / `redoStack` / `pending` / `baseRevision` / `saveState` 全部不存在了。

store 的职责边界：

- **状态**：`meta`（FlowSummary 部分）、`nodes` / `edges` / `graphMeta`（**Y.Doc 的只读投影**，`observeDeep` 一变就重算）、`viewport`、`userState`、`canUndo` / `canRedo`、`lastLabel`。
- **唯一写入口**：所有内容变更都通过 `mutate(change, label?)`，它把改动包进一个带 `LOCAL_ORIGIN` 的 `doc.transact()`。组件**不许直接碰 Y.Map** —— 绕过去的改动既不进撤销、也不同步、更不落库。`label` 只给界面反馈用，CRDT 不需要它。
- **文档形状**（`src/lib/flow-doc.ts`，服务端镜像 `server/collab/flow-doc.ts`，改一边要改另一边）：`nodes` / `edges` 是 `Y.Map<id, Y.Map>`，每个节点的 `data` 又是一层嵌套的 `Y.Map`。**这样分层是为了让 Y.Map 按 key 合并** —— 一个人改标题、另一个人同时拖位置能干净地合并；整个节点存成一个 JSON blob 的话，后写的那次会把先写的整体盖掉。
- **撤销 / 重做**：`Y.UndoManager`，`trackedOrigins: [LOCAL_ORIGIN]`。就是这一个选项让 `Ctrl+Z` **只撤自己的**，不碰协作者的改动。`separateUndo()`（`stopCapturing`）把本会并进 400ms 捕获窗口的两次操作拆成两条记录。
- **历史仍然只在内存里**：刷新即清空，撤销不跨会话；内容本身当然不丢。
- **没有保存、没有 revision、没有 409、没有 dirty state**：改动即刻广播，服务端订阅同一个文档并落库（[REQ-COLLAB §3.7](04-realtime-collab.md)）。
- **拖动的中间态故意不进文档**：只有 `onNodeDragStop` 的落点进 `mutate`，途中的位置走反馈层。否则一次拖拽就是几十条更新和几十行审计。
- **视图状态是另一条路**：`setViewport()` / `setUserState(key, 值)` 只改本地、**不发请求**，落库搭下一次本地编辑的车（见 3.5.1）。存失败不弹提示（丢了最多是下次打开回到上一个存住的视图），值留在队列里下次再发；`saveNow()`（离开前）会把它 flush 掉。
- Vue Flow 的双向绑定不能绕开 store：拖动结束（`nodeDragStop`）、连线建立（`connect`）、删除，都转成对 `mutate` 的调用。
- **拖动期间不许重建 `:nodes` 数组** —— Vue Flow 按数组引用决定要不要重新同步，而重新同步走的是 `Object.assign(existing, incoming)`；拖动中间态既然不进文档，`incoming.position` 就是拖动前的位置，节点会在手底下弹回去。`useFlowCanvas` 为此留了一个 `localDragging` 标志，详见 [REQ-COLLAB §4.0.2](04-realtime-collab.md)。

另有 `src/stores/project.ts` 持有当前项目与成员列表（供项目主页三个区域共享），职责简单，不涉及历史。

### 4.6 内容是怎么落库的

> **原本这里是 `POST /api/flows/:id/commit`**：body 带 `baseRevision` + 事务数组 + 客户端算好的全量 graph 快照，
> 服务端校验 `baseRevision === flow.revision`，不匹配就 409、让后来者重新加载。
> 它建立在「同一时刻只有一个编辑者」这个假设上，协同一上就整个失效了 —— 而且**必须**失效：
> 客户端手里的 graph 只是某一时刻的快照，拿它覆盖服务端就会抹掉同一秒里别人的编辑，
> 这正是 CRDT 要消灭的那个「后写覆盖先写」。**这个端点已经删除，前端没有任何提交动作。**

现在的路径是：

```
浏览器 ──Yjs update──▶ /ws/collaboration ──▶ Hocuspocus 房间 flow:<id> 的 Y.Doc
                                 ├─ onChange：每条更新即时写 FlowOperation（带握手认定的 actorId）
                                 └─ onStoreDocument：全量状态写 Flow.ydoc + 派生 graph/计数
                                    （框架自带防抖：2s，持续编辑最长 10s；散场时再存一次）
```

- 服务端**订阅**文档，不接受任何「这是全量内容，请覆盖」的请求。
- 幂等来自 Yjs 本身：同一条更新应用两次不会产生第二个节点，所以不需要 `txId` 那样的去重键。
- 落库时机由 Hocuspocus 管，不是我们自己写的定时器。最多丢一个防抖窗口（进程被 `kill -9` 时），
  正常退出会 `closeConnections()` 后逐房间直接落库（`flushAllRoomsToDatabase`）再等写队列排空。更新流是即时写的，不受影响。
- 细节全在 [REQ-COLLAB](04-realtime-collab.md)：§3.7 讲写入时机与「不用 y-leveldb / 不用 extension-database」的理由，
  §4 讲数据层 / 反馈层的分工，§4.2 讲三道防线。

### 4.7 API

**项目**

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/projects` | 登录 | 我参与的项目，分页。query：`page`、`pageSize`、`keyword`。响应 `{ items: ProjectSummary[], page, pageSize, total, totalPages }` |
| POST | `/api/projects` | 登录 | 新建。body `{ name, description? }`；同事务里写入创建者的 admin 成员行。**201** + `ProjectSummary` |
| GET | `/api/projects/:id` | member | 详情（含 `myRole`）；非成员 → 404 |
| PATCH | `/api/projects/:id` | admin | 改名 / 描述 |
| DELETE | `/api/projects/:id` | admin | 软删除，204；项目下的画布一并视为不可见 |

**成员与邀请**

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/projects/:id/members` | member | 成员列表（本期不分页，上限见 4.9） |
| DELETE | `/api/projects/:id/members/:userId` | admin | 移除成员；不能移除自己 → 400 |
| GET | `/api/projects/:id/invite` | admin | 该项目的分享链接（含 token 与拼好的完整 URL）。**幂等且会写**：没有链接、或已过期就当场换一条新的 |
| PATCH | `/api/projects/:id/invite` | admin | 改有效期。body `{ expiresInDays: 1\|7\|30 }`；**token 不变** |
| POST | `/api/projects/:id/invite/reset` | admin | 重置：换 token，旧链接立刻失效。body `{ expiresInDays?: 1\|7\|30 }` |
| GET | `/api/invites/:token` | 登录 | 链接预览 `{ valid, reason?, projectId, projectName, memberCount, alreadyMember }`；**不校验成员身份**（访问者当然还不是成员），但要求已登录 |
| POST | `/api/invites/:token/accept` | 登录 | 接受，写入 `ProjectMember`，返回 `{ projectId }`；已是成员则幂等返回 |

**画布**

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/projects/:id/flows` | member | 项目内画布分页。query：`page`（默认 1）、`pageSize`（默认 20，上限 100）、`keyword`、`status`、`sort`（`updatedAt:desc` 等）。**响应不含 graph** |
| POST | `/api/projects/:id/flows` | member | 新建。body `{ name, description? }`；**201** + `FlowDetail`（空 graph） |
| GET | `/api/flows/:id` | member | 文档元信息 + **请求者自己**的 `userState`（见 3.5.1）。`graph` 是只读投影，编辑器不读它（内容从 WebSocket 来） |
| PATCH | `/api/flows/:id` | member | 改名 / 描述 / 状态 / 标签；**不能**改内容、不能改 projectId |
| DELETE | `/api/flows/:id` | member | 软删除，204 空 body |
| POST | `/api/flows/:id/duplicate` | member | 在同项目内复制一份（名称加「副本」后缀），201；更新流不复制，新画布 `revision` 从 0 起 |
| PATCH | `/api/flows/:id/user-state` | member | 存**我自己**的视图状态（视口…），body 只带要改的分区，204。不涨 `revision`、不写更新流、没有乐观锁 |
| GET | `/api/flows/:id/operations` | member | 更新流分页（`page` / `pageSize` / `sinceSeq`），供调试与将来的回放。只出元信息，不出 `update` 字节 |
| — | ~~`POST /api/flows/:id/commit`~~ | — | **已删除**，见 4.6。内容不再经过 HTTP |

**画布内容走的不是 HTTP**：`ws://<host>/ws/collaboration`（房间 `flow:<flowId>` 走消息，不在路径里），握手时按项目成员身份鉴权（`server/auth/ws.ts`），此后服务端还会持续确认这条连接的权限还在：**移除成员 / 删项目 / 删画布这三个接口会当场把受影响的 WebSocket 踢掉**（本实例立即，其它实例 ≤3 秒），另有每 20 秒一轮的复验兜底。所以「移除成员」对正在编辑的人不再有可观的窗口期——这很要紧，因为他在窗口期里改的东西会被 CRDT 合并落库，而留下的人**撤销不回来**（撤销只跟踪自己的操作）。踢下线时会区分「会话过期」和「不是成员了」，两者给用户的出路不同。协议与运行参数见 [REQ-COLLAB](04-realtime-collab.md)。

约定沿用 [REQ-DATA](05-data-persistence.md)：错误响应统一 `{ error: string }`；请求体非法 JSON → 400；参数校验在路由层，数据访问全在 `server/store/projects.ts` 与 `server/store/flows.ts`，路由文件里不出现 `prisma`。

所有端点在 `/api/*` 之下，因此默认需要登录（[REQ-AUTH](02-auth-keycloak.md)）。

### 4.8 鉴权规则

- **画布的访问权完全由项目成员身份决定**，与 `Flow.createdById` 无关。
- `/api/flows/:id` 系列先按 id 查出 `projectId`，再查请求者是不是该项目成员 —— 这段判断收敛到一个中间件（如 `server/auth/project.ts` 的 `requireProjectMember` / `requireProjectAdmin`），路由里不重复写。
- **非成员访问一律 404，不是 403**（不泄露项目/画布是否存在）。成员但权限不足（member 干 admin 的事）才是 **403**。
- 软删的项目 / 画布对所有人都等同于不存在（404）。**软删就到此为止**：不清理、不物理删除、不提供恢复入口 —— `deletedAt` 只是一道过滤条件，数据留在库里当兜底，真要捞得手工进库。
- 唯一的例外是 `/api/invites/:token` 两个端点：它们按 token 鉴权而非成员身份，只要求登录。

### 4.9 校验规则

- 项目 `name`、画布 `name`：非空字符串，trim 后 1..80 字符。
- `pageSize`：1..100 的整数，越界 → 400。
- 分享链接 `expiresInDays` 只接受 1 / 7 / 30。
- 单项目成员上限 200、画布上限 500，超出 → 400 并给出明确文案。
- `graph`：**没有任何接口接受它了**，所以不存在请求体校验。`parseGraph` 仍在 `server/store/flow-types.ts` 里，用途变成两处**读**：把库里的老 `graph` JSON 灌进 Y.Doc 时（`bindState` 的迁移），以及列表页读投影时。读到坏数据的策略是**跳过而不是报错** —— 那是历史数据，拒绝它只会让画布打不开。
- `user-state`：body 必须是非空对象；**未登记的分区 key → 400**；每个分区按 `FLOW_USER_STATE_PARSERS` 里自己的规则校验（视口要求 `x`/`y`/`zoom` 都是有限数字且 `zoom > 0`）；单个分区序列化后 16KB 封顶。任一分区不合法就整体拒绝，不「对一半存一半」。
- 单个画布上限：**节点 2000、边 4000、文档 2MB、单条消息 1MB**（数字从 `GRAPH_LIMITS` 派生），
  拦在 WebSocket 那一层（见 [REQ-COLLAB §4.2](04-realtime-collab.md)）。配额分两级：超**软限**只标记，
  写入照常（删回去自动解除 —— 否则谁也删不了东西，房间就死了）；顶到**硬限**（软限 × 1.25）才锁写，
  锁到散场重开。拒绝走连接 `readOnly`（NACK 不断连），绝不 `throw` —— throw 会让 Hocuspocus 关连接，
  超限房间对所有人不可达。
- **身份不接受客户端自报**：awareness 里的 `user` 在服务端转发前被覆盖成握手认定的那一份
  （见 [REQ-COLLAB §4.2](04-realtime-collab.md) 的第一道防线）。光标、选中这些不管 —— 它们不是身份。

## 5. 验收标准

**项目与成员**

- [ ] 新建项目后，`ProjectMember` 里存在创建者的 admin 行，成员列表能看到自己。
- [ ] 项目列表只出现我是成员的项目；别人的项目 id 直接访问返回 404。
- [ ] admin 点「分享」→ 面板里**直接就有链接**（不需要先选有效期再生成），另一个账号点开 → 看到项目名与成员数 → 点「加入」→ 落到项目主页，成员列表多一行。
- [ ] 同一条链接可以被任意多人使用，人数不设限。
- [ ] 未登录点开分享链接 → 跳登录 → 登录后自动回到确认加入页，而不是首页。
- [ ] 同一条链接重复点「加入」不会产生第二条成员记录。
- [ ] 改有效期后 token 不变；「重置链接」后旧链接立刻失效，新链接可用；项目始终只有一条链接。
- [ ] 过期 / 无效（含被重置）/ 项目已删各给各的文案，不是同一句「链接无效」。
- [ ] member 调用看分享链接、重置链接、移除成员、改项目名、删项目，全部返回 403。
- [ ] admin 移除自己返回 400。
- [ ] 成员被移除后，立刻访问该项目及其画布返回 404。
- [ ] 项目主页在**一个路由**内用同页 Tab 展示画布与成员；来回切 Tab 不改变 URL、不重新请求、不闪 loading。

**画布与历史**

- [x] 画布列表能翻页，页码与关键字反映在 URL 上，刷新后状态不变。
- [x] 列表接口的响应体里没有 `graph` 字段。（server/test/routes/flows.test.ts）
- [ ] 从画布列表点开一张画布，落到 `/flows/:id` 独立整页：**没有侧边栏**、没有项目主页的分区，画布占满视口；退回项目主页后侧边栏恢复。
- [ ] 左上角悬浮胶囊显示 logo + 画布名 + 菜单按钮；点 logo 回到所属项目主页。
- [ ] 胶囊菜单四项都可用：新建画布落到同一项目下的新画布、复制落到副本、删除后回项目主页、「返回画布首页」与点 logo 去到同一处。
- [ ] 点「新建画布」跳走之前，攒着的视图状态先落库；内容不需要等待（它一直是同步的）。
- [x] 新建 → 编辑 → 刷新页面，节点、连线、视口全部还原。（浏览器回归）
- [ ] 连续做 5 步操作后按 5 次 `Ctrl+Z` 回到初始状态，再按 5 次 `Ctrl+Shift+Z` 完全恢复。
- [ ] 框选多个节点一起拖动，只需一次撤销即可整体回退。
- [ ] 撤销之后再做新操作，重做栈被清空（重做按钮变灰）。
- [ ] 刷新页面后撤销栈为空、撤销按钮变灰，但画布内容完好。
- [ ] 断网时继续编辑不报错；恢复连接后改动自动补同步，不需要用户做任何事。
- [x] 同项目两个成员同时打开同一张画布，**两边的改动都留下**（不同字段真合并），没有 409、没有「请重新加载」。（浏览器回归 + src/test/stores/flow.test.ts）
- [x] 一方拖动节点时另一方在场：拖动过程中本地节点不会弹回原位（`localDragging`）。（浏览器回归）
- [x] 同一条 Yjs 更新被应用两次，画布上不会出现第二个节点。（src/test/stores/flow.test.ts）
- [x] 删除键删掉的节点会同步给对方、也会落库（即没有绕开 store）。（浏览器回归）
- [x] 节点 `data.config` 里塞任意结构的 JSON，存取一字不差。（server/test/routes/flows.test.ts）
- [ ] 平移/缩放后刷新，视口回到离开时的位置；撤销按钮不会因为只挪了画布而变亮，撤销也拽不回视野。
- [x] **只平移不编辑时一个写请求都不发**；发生一次编辑后，攒着的视口立刻被顺路 PATCH 上去，之后的连续编辑合成一发在手停时补齐（一直不停手由 `maxWait` 顶上）。（src/test/stores/flow.test.ts）
- [ ] 同一张画布两个人各自平移到不同位置，互不影响；第三个人第一次打开时按投影里的兜底视口（或 fitView）。
- [x] 一张 `ydoc` 为空的老画布被打开后，旧 `graph` JSON 的内容原样出现在画布上，且此后以 Y.Doc 为准。（server/test/routes/flows.test.ts）
- [x] `FlowOperation` 里每条记录的 `actorId` 是服务端认定的登录用户，客户端改不了。（server/test/routes/flows.test.ts）
- [x] A 项目的成员访问 B 项目的画布 id 返回 404；未登录访问任一 `/api/projects*` / `/api/flows*` 返回 401；非项目成员连 `flow:<id>` 房间的 WebSocket 被拒。（server/test/auth/ws.test.ts + routes 测试）
- [x] 一方伪造 awareness 里的身份，另一方看到的仍是服务端认定的真身；光标位置不受影响。（浏览器实测 + server/test/collab/hardening.test.ts）
- [x] 节点 / 连线数超过上限后，房间被标记为拒绝写入；散场后重新判定。（server/test/collab/hardening.test.ts）
- [x] 并发「删节点 + 连线」留下的悬空边在落库前被清掉，且不进任何人的撤销栈。（server/test/collab/hardening.test.ts）

**测试覆盖**

- [x] `server/test/routes/projects.test.ts` —— 创建即 admin、成员隔离 404、admin/member 权限分界 403。
- [x] `server/test/routes/invites.test.ts` —— 幂等取链接、过期自动换新、改有效期不换 token、重置、预览、接受、多人复用、失效文案。
- [x] `server/test/routes/flows.test.ts` —— 分页、校验、跨项目 404、**画布内容的写入路径（Yjs）**、duplicate、`user-state` 各存各的 / 覆盖 / 不涨 revision / 校验 / 非成员 404 / 随画布级联删除、`operations` 分页。
- [x] `server/test/auth/ws.test.ts` —— WebSocket 握手鉴权：匿名拒、登录但非项目成员拒、成员放行并带出 `actorId`。
- [x] `src/test/stores/flow.test.ts` —— Y.Doc 投影（写进得去、读得出来）、用第二个 `Y.Doc` 扮演协作者验证**同一节点不同字段的并发编辑真合并**、撤销只撤自己的、视口不进文档、视口只在本地编辑后才落库（五种请求形态）。
- [x] `src/test/lib/presence.test.ts` —— 反馈层的纯逻辑：颜色哈希、防御式解析对端状态、占用仲裁（不带 socket）。
- ~~`src/test/stores/flow-commands.test.ts` / `flow-sync.test.ts`~~ —— 随命令注册表与提交队列一起删除。

## 6. 本期不做

- ~~**多人实时协同编辑**~~ —— **已经做了**，见 [REQ-COLLAB](04-realtime-collab.md)。本文原本按单编辑者设计（没有在线状态、没有光标共享、没有合并策略，冲突只是「后写的人被拦下并重新加载」），那一套已被 Yjs 全面替掉。
- 编辑锁 / 抢占提示（「张三正在编辑这张画布」）。仲裁逻辑写好了也有测试，但**当前没接进画布**：谁都可以同时改同一样东西，由 CRDT 合并，节点标签上只是*显示*还有谁在碰它。要恢复限制见 [REQ-COLLAB §4.0.1](04-realtime-collab.md)。
- ~~**画布规模上限的强制**~~ —— **已经做了**，拦在 WebSocket 那一层（见 4.9 与 [REQ-COLLAB §4.2](04-realtime-collab.md)）。
- **多进程部署**：房间的 Y.Doc 只活在单个进程的内存里，所以仍必须 `replicas: 1`。
  换了 Hocuspocus 之后这条有了现成的路（`@hocuspocus/extension-redis`），但没有需求就没接。
- 操作日志的回放界面与「历史版本预览 / 回滚到某个时刻」—— 数据（按 seq 排列的更新流）已经够重建任意时刻了，只是没做界面。
- 邮箱邀请、按用户名直接添加成员、加入申请与审批 —— **分享链接是唯一入口**。
- 一个项目多条分享链接、按人/按用途分发、使用次数上限、链接维度的加入记录。
- 转让管理员、多管理员之外的自定义角色、画布级别的细粒度权限（项目内成员平权）。
- 主动退出项目（先只有被 admin 移除）。
- 项目层面的操作审计（谁改了项目名、谁移除了谁）。
- 操作日志的清理 —— **先只存不清**，无限增长；等量级真成问题再补清理任务。
- 软删数据的清理任务与「回收站 / 恢复」入口 —— 删了就是删了，`deletedAt` 只过滤不回收。
- 撤销栈跨会话保留。
- 画布缩略图生成。
- 节点 `config` 的按 `kind` 定制表单与合法性校验（本期 JSON 编辑器兜底，服务端只透传）。
- 连线合法性校验（`dataType` 只存不判）。
- 分组 / 子流程（`parentNode` 字段先留着不用）。
- 自动布局、导入导出、导出图片。
- 跨画布、跨项目的节点复制粘贴；画布在项目间移动。

## 7. 待确认事项

暂无 —— 前几轮提出的问题已全部拍板并写进上文：撤销栈不跨会话、操作日志只存不清、项目主页用同页 Tab、软删不清理不恢复、侧栏用「画布项目」替掉原来的「VueFlow」入口。

实现过程中新冒出来的取舍，追加到这里。

**Yjs 改造带来的取舍（按发生顺序）**

1. **内容不再有「保存」**。用 CRDT 就不能再让客户端上传全量快照覆盖服务端 —— 那会抹掉并发的编辑。于是提交、`baseRevision` 乐观锁、409、「未保存」指示、`beforeunload` 拦截全部随之消失。想要一个用户可见的「保存」动作只剩一条正当路径：**显式快照 / 发版**（`Y.snapshot()`，需要 `YWS_GC=false`），那是给当前状态打标记，不是上传当前状态。还没做。
2. **`graph` 从事实源降级为投影**，`FlowOperation` 从语义化操作降级为字节流。换来的是 `actorId` —— Yjs 只认 `clientID`，「谁改的」这个信息只能由服务端在握手时认定并单独存下来。
3. **老数据的迁移放在 `bindState` 里**，不写迁移脚本：每张画布在第一次被打开时自己完成，没打开过的原样躺着，也就没有停机窗口。
4. **协同服务端换成了 Hocuspocus**（[REQ-COLLAB §2](04-realtime-collab.md)）。原来是一份 y-websocket
   `bin/utils.js` 的移植（282 行），协议、心跳、房间生命周期全得自己维护。换掉的代价是**线协议不兼容**
   （Hocuspocus 每条消息以文档名开头，房间名走消息不走 URL），前端必须改用 `@hocuspocus/provider`；
   换来的是落库时机、房间生命周期归上游管，外加几个我们自己写要花功夫的挂点（下一条）。
5. **服务端从「只转发」变成「有话语权」**。CRDT 之后内容不经过任何带校验的 HTTP 端点，
   校验只能挪到协同链路上，于是有了三道防线（[REQ-COLLAB §4.2](04-realtime-collab.md)）：
   身份改写、内容配额、悬空边清理。其中**身份改写**是唯一能杜绝同房间冒名的地方 ——
   awareness 本来完全由客户端说了算。
6. **视图状态搭本地编辑的车落库**（3.5.1）。内容走 Yjs 之后，视口若还自己起定时器防抖 PATCH，它就成了整个编辑器**唯一**的周期性 HTTP 请求 —— 只看不改也一路往上 PATCH，很没道理。绑到编辑事件上之后，纯浏览零写流量。附带的好处：编辑时天然会刷新登录会话，专心画图不会因为 Keycloak 的 SSO idle 掉线（[REQ-AUTH §3.3](02-auth-keycloak.md)）。
