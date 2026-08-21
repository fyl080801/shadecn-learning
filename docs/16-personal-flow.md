# REQ-SOLO 个人画布（不走协同的画布）

> 状态：**已实现** —— 数据模型、`applyFlowUpdate` 写入通道、两条 REST、两处互拒、
> 前端同步层（`useFlowSync` + 两种 transport）、`/personal` 界面均已落地，
> 测试见第 5 节。
>
> 前置：[REQ-CANVAS](13-flow-canvas-management.md)（项目 / 画布 / 成员 / 分享链接）与
> [REQ-COLLAB](04-realtime-collab.md)（Yjs 实时协同）。本需求在两者之上补一件事：
> **有些画布只属于我一个人，不该为它开一条 WebSocket、一间房、一套在场与踢人逻辑。**

## 1. 目标

1. 引入**个人画布**：只有创建者本人能看能改，没有成员、没有分享链接、没有实时协同。
2. **内容模型不分叉** —— 个人画布和项目画布的内容都是 Y.Doc，库里都是 `Flow.ydoc` 字节。
   分叉只发生在**传输**这一层：项目画布走 Hocuspocus WebSocket，个人画布走 HTTP 增量推拉。
3. 编辑器**只有一个**。`stores/flow`、`useFlowCanvas`、吸附、快捷键、工具栏、节点组件全部原样复用，
   两种画布的差别对它们不可见。
4. 因为字节格式一致，将来「把个人画布移进项目」只是改一个 `projectId`（本期不做，但模型要支持）。

### 1.1 为什么不让个人画布退回老的 `graph` JSON 存法

协同之前画布是「前端攒操作 → 防抖 `POST /commit` → 按 `baseRevision` 乐观锁 → 覆盖 graph 快照」，
个人画布看上去正好适合这套。**但这条路会立刻付出四份代价**：两套存储格式、两套 store、
两套撤销（`Y.UndoManager` vs 手写栈）、两套投影；而且个人画布从此**无法**变成项目画布 ——
两种格式之间的转换是有损的（JSON 快照里没有 CRDT 的因果信息，转过去等于所有历史归零）。

个人画布真正缺的只有「把改动发给别人」这一件事。缺的是传输，不是模型。

## 2. 名词

| 名词 | 含义 |
|---|---|
| 个人空间 / Personal space | 每个用户一个的私人容器。它**就是一个 `Project`**，只是 `kind = 'personal'`、成员只有自己 |
| 个人画布 / Solo flow | 个人空间里的画布。`mode = 'solo'`，不进协同层 |
| 项目画布 / Collab flow | 团队项目里的画布。`mode = 'collab'`，行为与今天完全一致 |
| 传输 / Transport | 把本地 Y.Doc 的改动送出去、把别处的改动收回来的那一层。协同是 WebSocket，个人是 HTTP |
| 状态向量 / State vector | Yjs 的「我已经知道到哪儿了」摘要，几十字节。个人画布的推拉协议以它为准 |

## 3. 数据结构设计

### 3.1 个人空间就是一个 Project

```prisma
model Project {
  /// team | personal —— personal 是每人一个的私人空间，里面的画布不走协同
  kind            String  @default("team")
  /// 个人空间的归属者；团队项目为 null。unique 保证「一人最多一个」
  personalOwnerId String? @unique
  personalOwner   User?   @relation("PersonalSpace", fields: [personalOwnerId], references: [id], onDelete: Cascade)
}
```

**为什么不是 `Flow.projectId` 可空 + `Flow.ownerId`。** 那个模型看起来更直白，代价却是
`requireFlowMember`、`projects.roleOf`、`flows.list`、软删、复制、`authorizeCollab`、`projectIdOf`
统统要长出一条 `projectId === null` 的分支，而**每一条分支都是一次漏判的机会** ——
这个项目的鉴权铁律是「非成员一律 404，不泄露存在性」，多一条旁路就多一处可能绕开它的地方。

走个人项目则**一行鉴权代码都不用改**：`projects.roleOf(个人空间, 本人)` 天然返回 `admin`，
别人天然返回 `null` → 404。成员表里真实存在那一行 admin 记录，和项目创建者的处理方式一致
（[REQ-CANVAS §3.10](13-flow-canvas-management.md) 的老规矩：创建者的 admin 行是写出来的，不靠推断）。

代价是两条，都可控：多一行 Project 记录；以及要在项目侧**堵住 personal 的口子**（见 §4.5）。

**创建时机是懒创建**：`ensurePersonalProject(userId)`（按 `personalOwnerId` upsert），
第一次进「个人画布」页或第一次新建个人画布时建。**不挂 `registerProfileHook`** ——
登录路径不该为一个可能永远不会被用到的功能多写一次库。

### 3.2 `mode` 是派生的，不存在 Flow 上

`Flow` **不加字段**。`mode` 是 `project.kind` 的函数：

```ts
type FlowMode = 'solo' | 'collab'   // project.kind === 'personal' ? 'solo' : 'collab'
```

存两份必然漂移（改了归属忘了改标记，就会出现「在团队项目里但不同步」的画布，
而且没人能一眼看出是哪边错了）。服务端是 `mode` 的**唯一判定者**，客户端只是照着执行 ——
客户端自己声明的 mode 一律不可信，见 §4.4 的两道拒绝。

接口上：

```ts
interface FlowSummary {
  // ……原有字段不变
  /** 由所属项目派生：个人空间里的是 solo，团队项目里的是 collab */
  mode: FlowMode
}

interface ProjectSummary {
  // ……原有字段不变
  kind: 'team' | 'personal'
}
```

### 3.3 内容的存法：一模一样

| | 个人画布 | 项目画布 |
|---|---|---|
| 内容事实源 | `Flow.ydoc`（Yjs 状态字节） | 同左 |
| `Flow.graph` | 服务端派生的只读投影 | 同左 |
| `FlowUserState`（视口） | 照旧，一人一行 | 照旧 |
| `revision` | 服务端写状态的计数 | 同左 |

只有一处粒度差别：个人画布的推送是**防抖后的一段合并增量**（一串编辑一次），
项目画布是**每次 Y 事务一次**。落库结果一样 —— `applyUpdate` 是合并语义，
顺序无关、幂等，合成一段推还是拆开推收敛到同一个文档。

## 4. 功能需求

### 4.1 服务端：一个写入口

今天「收到一段 Yjs update 之后要做的事」散在 `hocuspocus.ts` 的 hooks 和 `persistence.ts` 里。
把它抽成一个函数（`server/collab/flow-writer.ts`）：

```ts
applyFlowUpdate(flowId, update: Uint8Array) → { stateVector: Uint8Array } | { denied: 'too-large' }
```

内部顺序：配额检查（同一套 `COLLAB_LIMITS` / `GRAPH_LIMITS`）→ 合并进库里的 ydoc →
按时机派生 `graph` 投影。协同路径由 hooks 调它，个人路径由 REST 调它 ——
**配额与投影因此只有一份实现**。

三个必须做对的点：

- **服务端是 `applyUpdate` 合并，不是覆盖。** 读 `ydoc` → 新建 Y.Doc → apply 旧 → apply 新 →
  `encodeStateAsUpdate` 写回，整段跑在 `persistence.ts` 现成的 per-flow 队列里
  （和协同的落库排**同一条**队 —— 写的是同一行，各排各的等于没排）。
  覆盖语义会让同一个人的两个标签页互相抹掉对方。
- **跨实例的并发写靠 `revision` 做 CAS，不靠锁。** 队列只在进程内有效；多副本下两个实例
  各自「读-合并-写回」，后写的会盖掉先写的。所以写回时把读到的 `revision` 带进 `where`，
  没写中就重读重来（CRDT 重放同一段更新是幂等的，合并两次结果一样）。
  **这不是给客户端的乐观锁** —— 重试在服务端内部消化，客户端永远看不到 409，
  协同上来之后作废的那套东西不要从这里复活。
  `cluster/shared.ts` 的 `SharedLock` **不能**用在这儿：它的内存实现是「复用同一个
  in-flight promise」，两个内容不同的并发推送会让第二个拿到第一个的结果、
  它自己的 update 从未被应用 —— 那是「同一件事只做一次」的去重器，不是互斥锁。
- **推送协议以状态向量为准，不维护「未确认增量队列」。** 客户端每次上传
  `Y.encodeStateAsUpdate(doc, lastAckSV)`，服务端应答里回新的状态向量。
  Yjs 的合并是幂等的，所以**重发天然安全** —— 不需要事务 id、不需要在客户端持久化待发队列、
  断网重连后也不用对账，按当前 `lastAckSV` 重算一次 diff 就行。
- **`serverTs` 在收到请求的那一刻打**，不是排到队列里再打。理由同
  [REQ-CLUSTER](14-clustering.md)：队列前面可能压着别的写，记晚了就成了「什么时候轮到它」。

### 4.2 服务端：两条 REST

```
GET  /api/projects/personal             → ProjectSummary（kind='personal'）
     读接口也会建：第一次进「个人画布」页就有了。拿到 id 之后，列表 / 新建 /
     改名 / 删除全部复用 /api/projects/:id/flows —— 个人空间在接口层就是个项目。

GET  /api/flows/:id/doc?sv=<base64url>  → application/octet-stream
     返回相对客户端状态向量的 diff；不带 sv 则返回全量。

POST /api/flows/:id/doc                 ← application/octet-stream（Yjs update 二进制）
     → { stateVector: <base64url>, revision: number, noop: boolean }
```

- `noop: true` = 这次推送什么也没带来（重发、或客户端只动了视口）：没写库、
  `revision` 也没涨。**幂等就落在这里** —— 同一段 update 推一百次也只有第一次留下痕迹。
- **`?sv=` 必须真的解一次**（`Y.decodeStateVector`）才算校验过。`Buffer.from(x, 'base64url')`
  对任何输入都能凑出一段字节，垃圾会一路传到 lib0 的解码器里才炸成
  `Integer out of Range` —— 那时已经是 500 了，而这明明是个 400。（踩过。）

- 配额超限：**413**，响应体给出原因。前端把它当作一种终局状态（§4.6 的 `too-large`）。
- 两条路由都在 `requireFlowMember` 之后，鉴权规则不变（非成员 404）。
- 请求体上限沿用 `COLLAB_LIMITS` 的单条消息上限。

### 4.3 投影（`Flow.graph`）的写时机

**个人画布：只要这次推送带来了真实的内容变更，就连投影一起写。**
个人画布的推送本身已经被防抖收敛成「一串编辑一次」，频率是「手停一下」的量级，
所以多派生一次 JSON 不贵；换来的是列表页的节点数、缩略图**始终跟得上**，
不用等人离开画布才更新。

**项目画布维持现状**（平时只写 `ydoc`，投影留到 `beforeUnloadDocument`）。
这个不对称是有意的：那边是每 2 秒一次的防抖写入流，而且房间里可能有好几个人同时在改，
每次都序列化整张图，开销要乘上编辑频率。

### 4.4 两条通道各自只服务自己的模式

| 试图做的事 | 结果 | 为什么 |
|---|---|---|
| solo 画布连 `/ws/collaboration` | `authorizeCollab` 拒，reason `forbidden` | 否则客户端手搓一个 provider 就绕过了 `mode`，个人画布上就出现了别人的光标 |
| collab 画布 `POST /doc` | **409** | 否则绕过独占、awareness 身份改写和内存里的活房间；写进去的东西会被房间的下一次落库覆盖掉 |

这是本需求唯一的安全面：`mode` 由服务端判定，且**两边都要主动拒绝对方的通道**，
只在客户端分流不算数。

### 4.5 项目侧要堵住的口子

`kind = 'personal'` 的项目上，下列操作一律拒绝（**403**，不是 404 —— 请求者确实是它的成员，
不存在泄露存在性的问题）：

- `GET / POST /api/projects/:id/invite`（分享链接）
- 成员的增删改
- 删除项目
- 改名 / 改描述（个人空间没有名字可言，界面上也不展示）

`GET /api/projects` **过滤掉** `kind = 'personal'`：个人空间不是一个「项目」，
不该出现在项目列表里，也不该被搜索到。

**个人空间不限制画布数量** —— `PROJECT_LIMITS.flows`（500）只对团队项目生效。
个人空间是自己的草稿箱，给它设一个会在某天挡住自己的上限没有意义。
（`PROJECT_LIMITS.members` 对它天然无关：永远只有一行。）

### 4.6 前端：把 Y.Doc 的生命周期和传输拆开

今天 `useFlowCollab` 一手包办 doc、IndexedDB、provider、终局关闭。拆成：

```
src/composables/flow/sync/
  useFlowSync.ts        // 唯一出口，对上层的形状 = 今天的 FlowCollab
  transport-collab.ts   // 今天 provider 那部分，原样搬过去
  transport-solo.ts     // 拉一次 + 防抖推
```

`FlowSyncSession` 就是今天的 `CollabSession`，只有一处变化：`awareness: Awareness | null`。

**关键点：doc 和 IndexedDB 立刻建，transport 等 `mode` 到达再挂。**
`mode` 来自 `GET /api/flows/:id`（异步），而 Y.Doc 与传输本来就是解耦的。这样既保住了
「先从本地缓存画出来」的离线体验（[REQ-COLLAB §3.8](04-realtime-collab.md)），
又不用把 `FlowEditor.vue` 拆成「外层先 await meta、内层才 provide」的两层组件。
`mode` 未知期间状态是 `connecting`，编辑器现有的加载门槛不变。

状态收敛成一个枚举，文案由 `useFlowDocument.syncText` 按 `mode` 出：

```ts
type FlowSyncStatus =
  | 'connecting' | 'live' | 'pending' | 'offline'
  | { fatal: 'superseded' | 'unauthorized' | 'forbidden' | 'too-large' }
```

- `superseded` / `forbidden` 在 solo 下**不可达**（没有别的窗口来顶，没有成员身份可撤）。
- `unauthorized` 两边都可达（会话过期），继续走全站的 `SessionExpiredDialog`。
- `too-large` 是 solo 独有的第四种终局：提示「画布太大，最近的改动没能保存」。
- solo 下**绝不能**出现「协作会话已过期，请刷新页面」这类文案。

推送节奏照抄 store 里已经验证过的形状（[REQ-CANVAS §4.6](13-flow-canvas-management.md)）：
**首次立刻推 + 防抖尾 + `maxWait`**，由 `doc.on('update')` 触发；
`flushBeforeLeave()` 在原有的 user-state 之外多推一发 doc。
推失败**不弹 toast**（改动还在 IndexedDB 里，没丢），只把状态显示成 `pending` / `offline`。

在场层：`useFlowPresence` 见到 `awareness === null` 就返回空集合、`publish*` 变 no-op，
`FlowPresenceBar` 自然渲染为空，`useFlowCanvas` 不需要知道这件事。

**验收这次改动切得对不对，看 diff 落在哪里**：不应该出现在 `src/stores/flow/`、
`useFlowCanvas.ts`、`useFlowSnapping.ts`、`useFlowShortcuts.ts`、`src/components/flow/*`
（在场栏空态与文案除外）。改到了这些文件，说明抽象切错了层。

### 4.7 会话心跳

项目画布那套「编辑 = 一次 user-state PATCH = 会话续期，只看不改 = 该超时就超时」
（[REQ-CANVAS §4.6](13-flow-canvas-management.md)）原样保留。

个人画布的 `POST /doc` 本身就是真实 HTTP 请求，顺带把心跳问题消掉了 ——
它没有一条长连接可以自己养活自己。

### 4.8 界面：个人画布是独立的一页、独立的侧栏入口

**不在任何列表里混着区分两种画布**，也**不在同一页用 Tab 区分**：

```
侧栏
 ├─「画布项目」  → /projects        只列项目（过滤掉 kind=personal），点进去是 /projects/:id
 └─「个人画布」  → /personal        直接列画布，点进去是 /flows/:id
```

> **改过一次口径。** 最初两者是 `/projects` 页上的两个并列 Tab（§7 里当时留着
> 「侧栏要不要给个人画布独立入口」这条待确认）。落地后的结论是：**要**。
> Tab 表达的是「同一个东西的两个视图」，而项目和个人画布是两种东西 ——
> 项目那一侧点进去还有一层（成员、分享、角色），个人画布点进去就是画布本身，
> 两侧的头部按钮、空态文案、能做的操作没有一个是共用的。放成 Tab 的代价是
> 「我现在在看哪一种」变成一个每次都要先看一眼才知道的问题，而且个人画布
> 作为一个天天要用的入口，被藏在另一个入口的第二个 Tab 底下。

- 列表本身是**同一个组件**（`src/components/canvas/FlowList.vue`）：搜索、排序、分页、
  新建 / 重命名 / 复制 / 删除全在里面，项目主页的画布 Tab 用的也是它。
  个人空间在接口层面就是个项目，所以组件只要一个 `projectId`，
  **不需要知道自己列的是哪一种**。
- 拆成两页之后，**两个列表各自独占一份 URL query**（都开 `FlowList` 的 `syncQuery`），
  页码 / 关键字刷新即回原处。这是拆页顺带解决掉的一个问题：并列 Tab 时期两个列表
  共用一份 `?page=`，本来就会互相串（「项目搜到第 3 页」跟过去落在一个空页上），
  所以当时只能让项目那一侧独占 URL、个人画布那侧退回组件内部 state。
- 个人画布页**没有**成员、没有分享按钮 —— 页面头部只有标题一行。
- 个人空间是**懒创建**的，而 `GET /api/projects/personal` 是个「读也会建」的接口 ——
  所以它挂在这一页的加载上，没进过 `/personal` 的人不会被凭空建出一个空间。

编辑器（`/flows/:id`）两种模式共用一个路由和一个组件：solo 下在场栏为空、
`FlowConnectionEndedDialog` 只在 collab 的终局原因下出现、标题胶囊的状态文案按 §4.6 走。

**胶囊左上角那个「回去」按钮按 `mode` 决定落点，不按 `projectId`**：solo 回 `/personal`，
collab 回 `/projects/:projectId`。个人空间是个项目，这是存储上的事实，不是用户看到的事实 ——
照着 `projectId` 跳，个人画布会落到一个摆着成员、分享、「返回全部项目」的项目主页上，
而那三样对个人空间全是 403。图标和文案跟着同一个判断走。删除后的落点同理，
且要在删之前算好。

反方向也堵上：`/projects/<个人空间 id>` 被直接打开时（老书签、历史记录），
`ProjectHome.vue` 读到 `kind === 'personal'` 就 `replace` 到 `/personal`。

### 4.9 鉴权规则

| 请求 | 个人画布 / 个人空间 | 说明 |
|---|---|---|
| 本人访问 | 通过（角色 `admin`） | 走的就是 `projects.roleOf`，没有特例代码 |
| 他人访问 | **404** | 和「不是项目成员」同一条路径，同一个口径 |
| 他人拿到画布 id 直接开 | **404** | 同上 —— `requireFlowMember` 一行未改 |
| 匿名 | 401 / 页面守卫跳登录 | 与全站一致 |

### 4.10 上线注意：这次 schema 变更会挡住不带 flag 的 `db push`

`Project` 上新增的 `personalOwnerId` 带 `@unique`，而 Prisma 对**新增 unique 约束**一律
发出「可能丢数据」的警告 —— 于是不带 `--accept-data-loss` 的 `prisma db push` 会**直接拒绝执行**。
两个 Dockerfile 和构建产物的 `db:push` 都**故意**没有这个 flag（宁可容器起不来，也不静默丢数据），
所以这次变更需要一次人工干预。

实际的 DDL 是纯新增，没有任何 DROP：

```sql
ALTER TABLE "Project" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'team', ADD COLUMN "personalOwnerId" TEXT;
CREATE UNIQUE INDEX "Project_personalOwnerId_key" ON "Project"("personalOwnerId");
ALTER TABLE "Project" ADD CONSTRAINT "Project_personalOwnerId_fkey" FOREIGN KEY ("personalOwnerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

新列全是 NULL，两种数据库的 unique 都允许多行 NULL，所以约束建得上、也不会删任何东西。
**部署时手工执行一次这三条 DDL 即可**，之后正常的 `db push` 会发现无差异、直接放行。
不要为此给镜像的启动命令加上这个 flag —— 那等于把以后每一次真正破坏性的变更都放行了。

这不是个例，而是这个项目（没有迁移文件）固有的一类上线卡点：判断办法、三种处置、
以及「哪些明明安全却会被拦」列在 [REQ-DEPLOY §3.6](12-deployment.md)，
以后每次改模型都照那一节走。

## 5. 验收标准

**服务端**

1. solo 画布连 `/ws/collaboration` 被拒，reason 为 `forbidden`；客户端不重连。
2. collab 画布 `POST /doc` 返回 409。
3. `POST /doc` 幂等：同一段 update 推两次，画布里的节点不重复，第二次是 `noop`。
4. 并发合并：两个「标签页」各自基于同一 `lastAckSV` 推不同的改动，两边的改动都在，谁都没被抹掉。
5. 超过配额的推送返回 413，且**没有**写进 `ydoc`。
6. 一次成功的推送同时更新了 `graph` / `nodeCount` / `edgeCount`（§4.3）。
7. `ensurePersonalProject` 并发调用只产生一个个人空间（靠 `personalOwnerId` 的 unique）。
8. 个人空间不出现在 `GET /api/projects` 里；对它调分享 / 成员 / 删除接口得到 403。
9. 他人访问个人画布得到 404（不是 403）。
10. 个人空间新建第 501 张画布成功（不受 `PROJECT_LIMITS.flows` 限制）。
15. **写回被别的实例抢先 → 重读重来，两边的改动都在**，`revision` 对得上；
    一直抢不到就**抛错**而不是假装写成功（客户端据此保持「未保存」并稍后重试）。
    单进程内撞不上这一支（写队列已经把并发排开了），所以测试**人为制造**那个瞬间：
    spy `findFirst`，在它返回之后、写回之前从旁边直接写一次库。
    这条测试做过变异验证 —— 把 `where` 里的 `revision` 去掉，它确实会失败。

**前端**

11. `useFlowSync` 在 `mode = 'solo'` 时不创建 `HocuspocusProvider`。
12. `syncText` 文案矩阵：solo 下不会出现任何协同专属文案；`too-large` 有独立提示。
13. `stores/flow` 的既有测试**一行不改**照常通过 —— 这本身就是「模型没分叉」的证据。
14. `/personal` 与 `/projects` 是两个页面，各自独占一份 `page` / `keyword`，互不串。

### 5.1 落地时才发现的三件事

1. **`SharedLock` 不能用来串行化「内容不同的并发写」。** 它的内存实现是「复用同一个
   in-flight promise」—— 第二个请求会拿到第一个的结果，而它自己那段 update
   **从未被应用**，静默丢数据。它是「同一件事只做一次」的去重器（会话续期那种），
   不是互斥锁。跨实例改用 `revision` 做 CAS 重试（§4.1）。
2. **`?sv=` 必须真解一次。** 见 §4.2 —— 只看 base64 解得出字节的话，垃圾会一路传到
   lib0 才炸成 500。
3. **服务端必须把自己的状态向量给出来**（`x-flow-state-vector` 响应头）。
   客户端拿「合并之后的本地状态」当基线的话，离线期间攒在 IndexedDB 里的改动会被算成
   「服务端已经知道了」，差量恒为空 —— 那些改动再也推不出去，而界面一直显示「已保存」。
   前端对这一条有专门的回归测试。

## 6. 本期不做

- **个人画布 ↔ 项目画布互转**。模型已经支持（字节格式一致，转换 = 改 `projectId` + 让最后一发落地），
  但没有入口。这是选「归属决定模式」而不是「两套存储」的最大红利，留给下一期。
- **个人画布的多标签页实时同步**。同一个人开两个标签页看同一张个人画布是**最终一致**：
  两边各自本地编辑，服务端按 CRDT 合并，但对方的改动要刷新才看得到。
  这就是「个人画布不带协同」的定义本身 —— 不是缺陷，不要当 bug 修。
- 个人画布的在场、独占、权限复验、只读分享 —— 没有第二个人，全部不适用。
- 个人空间的重命名 / 多个人空间 / 空间级设置。
- 个人画布的历史版本（和项目画布同一个缺口，见 [REQ-COLLAB §9](04-realtime-collab.md)）。

## 7. 待确认事项

1. ~~**`FlowOperation` 对个人画布是否值得写。**~~ —— 已定：不写。操作日志整体移除了，
   两条通道都只写 `ydoc` + 投影（[REQ-DATA §5](05-data-persistence.md)）。
2. ~~**侧栏是否要给个人画布一个独立入口。**~~ —— 已定：给。个人画布已经提到侧栏一级
   （`/personal`），`/projects` 页回到只列项目，理由见 §4.8。
3. **推送防抖的窗口取值。** 暂定沿用 user-state 那组（2s / 10s `maxWait`），
   但那组是为「视口 + 心跳」调的；个人画布推的是内容，丢窗口的代价更大（只在本地留着），
   可能应该更短。
