# REQ-CANVAS 项目与画布管理

> 状态：**已实现** —— 后端（6 张表 + 三组路由 + 权限中间件）、Pinia store、四个页面均已落地，测试覆盖见第 5 节。
>
> 前置：[REQ-FLOW](09-flow-chart.md) 已经验证了 Vue Flow 的交互定制（滚轮手感、自定义节点、连线）。本需求接着往上叠**项目 + 多画布 + 持久化**，`/vue-flow` 那个单页 demo 变成「打开某一张画布」的编辑器形态。
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
5. 每一次更新**同时写库**：服务端订阅同一个文档，「刷新页面内容不丢」因此成立。
6. 数据结构从第一天起就为扩展留口子：节点除了 Vue Flow 的布局字段外，还有一块**自定义业务数据**；数据库统一按 **JSON 字符串**存，加字段不用迁移。

## 2. 名词

| 名词 | 含义 |
|---|---|
| 项目 / Project | 画布的容器与权限边界，成员的集合 |
| 成员 / Member | 项目内的一个用户，角色为管理员或普通成员 |
| 分享链接 / Invite | 一个带随机 token 的链接，是加入项目的唯一入口；一个项目只有一条 |
| 画布 / Flow | 一张图，列表里的一行，编辑器里的一个文档 |
| 图内容 / Graph | 画布的全量内容：`nodes` + `edges` + `viewport`。现在它是 **Y.Doc 的只读投影**，不再是事实源 |
| 文档 / Y.Doc | 画布内容的唯一事实源，形状见 `@shadecn/shared/flow-doc`（`packages/shared`，前后端共用一份；前端增量投影在 `apps/web/src/lib/flow-projection.ts`，服务端专属操作在 `apps/server/collab/flow-doc.ts`） |
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

**未登录用户点开分享链接是可用的**：`/invite/<token>` 是普通页面路径，会被 `apps/server/frontend/guard.ts` 拦下并 302 到 `/login?redirect=/invite/<token>`，登录完自动跳回，落在「确认加入」界面上。这条路径不需要额外开白名单。

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
| 存哪 | `Flow.ydoc`（事实源） | `FlowUserState`，每人一行 |
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

加一个分区要动三处、都不改表：`@shadecn/shared/flow-graph` 的 `FlowUserState` 加字段（前后端共用一份）、服务端 `apps/server/store/flow-types.ts` 的 `FLOW_USER_STATE_PARSERS` 加一条校验（它按 `FlowUserState` 的键做映射类型，漏加编译不过；**不认识的 key 一律 400** —— 这张表不是任意 KV）、前端 `store.setUserState('新字段', 值)`（攒批、失败重试、离开前落库都是现成的）。

**视图状态自己不发请求。** `setUserState` 只把值记在本地队列里，真正落库由 `noteLocalEdit()` 触发 —— 每次本地编辑（`mutate` / `undo` / `redo`）都会叫它一声，节奏是**先立刻发一次，再防抖收尾**：空闲之后的第一次编辑当场就走（leading，不等窗口），这之后的改动交给 `useDebounceFn`，手停下来 `USER_STATE_FLUSH_DELAY`（2s）补齐最后的状态，一直不停手则由 `maxWait`（`USER_STATE_FLUSH_MAX_WAIT`，10s）顶上去。于是：只看不改的一次访问**零写流量**；一串连续操作合成开头一发加收尾一发；**没有哪次改动被丢掉**。纯防抖不行是因为它有滞后（手不停就一直不发，而这趟还兼着会话心跳，见下），纯节流又会把窗口内最后那截改动整个丢掉。只有一次编辑时收尾那发发现没东西可送，不会白跑一趟。这条设计的由来：画布内容改走 Yjs 之后，视口若还自己起定时器，它就成了整个编辑器**唯一**的周期性 HTTP 请求 —— 看一眼画布就一路 PATCH 上去。

**这一趟 PATCH 同时是会话的心跳，所以窗口到点时一定发**：视图一次都没动过的话，就把当前视口当作要存的东西发出去。内容走 WebSocket 之后编辑本身不再产生任何 HTTP，而会话的空闲计时只认真实请求，服务端的协同复验又是只读的、特意不续期（[REQ-COLLAB](04-realtime-collab.md) 4.2）—— 少了这一发，一个人可以边正常编辑边被判空闲登出。合起来是一条完整的规则：**在编辑 = 每个窗口一次 PATCH = 会话续着；只看不改 = 零请求 = 该超时就超时。**

### 3.6 图内容（`FlowGraph`）—— Y.Doc 的只读投影

```ts
interface FlowGraph {
  schemaVersion: 3                       // 结构版本，后续结构调整靠它做兼容读取
  viewport: { x: number; y: number; zoom: number }
  nodes: FlowNodeRecord[]                // 只存节点自己的部分；派生的 inputs 不进投影
  edges: FlowEdge[]
  /** 画布级自定义数据，同样透传存储 */
  meta: Record<string, unknown>
}
```

> **v3 不迁移、不升级老数据，但读老数据绝不抛错。** v1 把业务种类放在 `data.kind`、业务字段裹在 `data.config` 里；v2 把业务字段平铺到 `data` 上，但 `label` / `status` / `createdAt` 这些框架字段也混在 `data` 里；v3 把节点拆成 `type` / `layout` / `metadata` / `data` / `runtime` 五组（见 3.7）。**存量数据先不管**是产品决定：不写迁移、不做握手版本拒连、不加 `meta.schemaVersion`，v1→v2 的就地升级代码（`upgradeNodeData` / `STRICT_UPGRADE` 那套）也一并删掉了。老数据照 v3 的规范化读（`nodeRecordFromParts`，Y.Doc 和 `Flow.graph` 走同一个函数）：布局字段本来就在节点顶层，原样读得出；没有 `metadata` / `runtime` 的退化成缺省值 —— 名字读出来是空串（界面上显示类型的兜底名）、状态 idle；原来混在 `data` 上的 `label` / `status` / `kind` / `config` 留在 `data` 里当普通业务字段。形状不对（没有合法 `position`）的节点照旧整条跳过。**`parseGraph()` 仍然收 v1 / v2**，不拒收是硬要求：老画布进 Yjs 的唯一入口 `loadFlowState()` 靠 `readGraph()` —— 那里读不出内容就返回 `null`，等于第一次打开老画布就把它清空；v1 / v2 的 `Flow.graph` 行布局是平铺在节点顶层的，`parseGraph` 两处都认。

**这个形状还在，但它的地位变了。** 原本 `graph` 是画布内容的事实源，客户端算好整份快照 `POST` 上来覆盖。
现在事实源是 `Flow.ydoc`，`graph` 由服务端在写状态时**从文档里派生**出来（`apps/server/collab/flow-doc.ts` 的 `readGraphFromDoc`），
只服务于三件事：列表页的节点/连线计数、缩略图、将来的只读预览。**编辑器一行都不读它**，
任何写接口也都不接受它 —— 客户端手里那份始终只是某一时刻的快照，拿它覆盖就会抹掉并发的编辑。

> `graph.viewport` 只是**兜底**：某人第一次打开、还没有自己的 `userState.viewport` 时用它，之后一律用个人视口。它**不跟着谁的平移缩放走**，否则我拖一下画布就改了别人的共享数据。

**老数据的迁移就是第一次打开**：`ydoc` 为空的画布在有人进房间时，由 `bindState` 把旧的 `graph` JSON 现场灌进文档（`applyGraphToDoc`）。没有迁移脚本、没有停机窗口，没被打开过的画布原样躺着。

### 3.7 节点（`FlowNode`）—— 五组：type / layout / metadata / data / runtime

**约定：按「谁在什么时候改它」分组。** 拖动只碰 layout，改名只碰 metadata，跑一次生成只碰 runtime，各节点类型的编辑入口只碰 data —— 混在一层里（v2 的 `data` 上同时住着 `label` / `status` / `prompt`）就只能靠一张「保留字清单」区分哪些是框架的、哪些是业务的。v3 起 **`data` 上没有任何保留字**。

```ts
interface FlowNode extends FlowNodeRecord {
  inputs: FlowNodeInput[]       // 派生，不存（见下）
}

interface FlowNodeRecord {      // 存下来的部分：Y.Doc 里有的、Flow.graph 投影里存的
  id: string
  type: string                  // 业务种类，也是节点类型注册表的键；建好不改
  layout: {                     // Vue Flow 认识的那些
    position: { x: number; y: number }
    width?: number              // 手动 resize 过才有
    height?: number
    zIndex?: number
    parentNode?: string         // 分组 / 子流程
    extent?: 'parent' | null
    sourcePosition?: 'left' | 'right' | 'top' | 'bottom'
    targetPosition?: 'left' | 'right' | 'top' | 'bottom'
  }
  metadata: {
    label: string               // 节点名；老数据没有 → 空串
    description?: string
    icon?: string               // lucide 图标名
    createdAt?: number          // UTC epoch 毫秒
    createdBy?: string          // 创建者的用户 id
    ui?: Record<string, unknown>  // UI 状态里需要持久化的部分（折叠、备注颜色…）
  }
  data: Record<string, unknown> // 纯业务字段，平铺；前后端都不解释，原样透传存储
  runtime: {
    status: 'idle' | 'processing' | 'completed' | 'error'
    error?: string
    taskId?: string
    outputs?: Record<string, unknown>  // 按输出端口 id 分键
  }
}

interface FlowNodeInput {       // 一条连进来的线
  port: string | null           // = edge.data.targetPort
  index: number                 // = edge.data.index；老边没有就是 0
  edgeId: string
  source: string
  sourcePort: string | null     // = edge.data.sourcePort
  value?: unknown               // = 上游 runtime.outputs[sourcePort]
}
```

**Y.Doc 里的物理布局**（`@shadecn/shared/flow-doc`）：

```
nodes/<id>: Y.Map
  type
  position, width, height, zIndex, parentNode, extent, sourcePosition, targetPosition   ← layout 留在顶层原位，不嵌套
  metadata: Y.Map   label, description, icon, createdAt, createdBy, ui
  data:     Y.Map   业务字段平铺
  runtime:  Y.Map   status, error, taskId, outputs.<portId>…
```

layout 不嵌套：拖动是最热的写路径，`position` 一直是顶层的一个 key，Vue Flow 本来也要平铺的形状 —— v3 的「归组」只发生在投影类型上，文档里的位置没动，所以老文档的位置原样读得出来。`metadata` / `runtime` 是 v3 新加的 key，从第一次写入起就是 `Y.Map`（3.7.1 那条「key 的类型首次写入即固定」不受影响）；老节点没有这两个 key，第一次写时现建（`nodeGroupMap(..., { create: true })`）。**运行态的产出按端口摊平**成 `outputs.<portId>` 一串平级的键（和 3.7.1 的平铺分键同一个思路），不存整块 `outputs` 对象 —— 一个端口出了新结果不该把另一个端口的整块盖掉。

**写一律按组**：前端 `store.writeNode(id, 'metadata' | 'data' | 'runtime', { set, remove })`（走 `store.mutate`，写和删同一个事务），节点组件经 `useFlowNode(id)` 调它（`rename` 写 `metadata.label`，`draft(组, 键, …)` 在某个字段上开 `useDraftField` 草稿）。layout 不走这里，拖动 / 拉伸 / 打组 / 解组各有自己的写路径，语义不变。agent 的 `update_node` 同样按组传参（`metadata` / `data` / `removeData`）。

**`type` 就是业务种类**，也是**节点类型注册表**的键。注册表分两半：**数据那一半**在 `@shadecn/shared/flow-node-types`（默认业务 `data`、默认布局、**端口声明**），前端和 agent 建节点都走 `buildNodeRecord`，默认值只有一份；**渲染那一半**在 `apps/web/src/components/flow/node-types.ts`（组件、图标、菜单名），用 `defineNodeType(type, 渲染)` 把两半拼起来。加一种节点只动这两张表，既有代码一行不动。

**可新建的节点类型只有四种**（`CREATABLE_NODE_TYPES`，工具栏菜单、出口候选菜单、agent 的 `add_node` 都只认它们，顺序即此）：

| type | 业务字段（`data`，平铺） | 「有内容 / 资源」（`hasNodeResource`） | body（内容区） | 底部输入框 |
|---|---|---|---|---|
| `text` 文本 | `text` 正文 | 正文非空白 | 输入框样子的正文区，双击编辑、失焦提交一次 | 没内容时有，有了就收起 |
| `image` 图片 | `src` 图片地址、`form` 形态 | `src` 非空白 | `<img :src>`；没有是「暂无图片」占位 + 「上传图片」按钮 | 看形态：generate 一直有（有了图也有），asset 没有 |
| `video` 视频 | `src` 视频地址、`poster` 预览图地址、`form` 形态 | `src` 非空白 | 平时只显示 `poster`（不常驻 `<video>`）；鼠标移上来，播放区换成 `<video>` 盖满整块（裁法同预览图）循环播放，移出就卸掉、换回预览图（同一时刻最多一个播放器）。播放时底部浮一条控制栏：播放 / 暂停、可拖的进度、`当前 / 总时长`、声音开关；默认静音，在某个节点上打开过声音，再移上来接着有声，浏览器不让有声自动播放就退回静音。画面本身不接鼠标（按住照样拖节点），只有控制栏不拖节点。每次移上来从头播。没有预览图时占位上移上来一样能播；没有是占位，没有视频时带「上传视频」按钮 | 同上 |
| `director` 导演台 | 无必填字段 | 永远没有 | 固定 240 × 240 正方形，中间一个「打开导演台」按钮，点了全屏打开导演台（[REQ-DIRECTOR](07-director-console.md) §2.1）；报错行接在方块下面，方块不变形；场景存在 `data` 的 `dc.*` 键里（REQ-DIRECTOR §7.2） | 一直有：回车打开导演台，并在这个节点最近的会话里发给 agent，消息开头带着它的提及（REQ-DIRECTOR §7.5） |

**图片 / 视频节点按资源的高宽比定尺寸**（视频看预览图，它就是视频的一帧）：竖图（高 > 宽）宽固定 240、高按比例；横图（宽 > 高）高固定 240、宽按比例；方图 240 × 240。长边最多是短边的 3 倍，更长的图按 3 倍裁掉两头（`object-cover`）。节点报错时，报错行接在图片下面，图片的大小和比例不变。资源加载完量一次，结果记进节点布局的 `width` / `height` —— 下次打开（包括别的协作者）直接按这个尺寸画，不等资源加载；还没量过的节点先按宽 320、高度随内容画。这次记录**不进撤销栈**，也不算一次编辑（不续会话）；值没变不重复写。

**图片 / 视频的两种形态**（`data.form`，平铺的字符串；文本、导演台没有形态）：

- **generate（生成）**：有底部输入框，接受连入 —— 「这张图 / 这段视频按连进来的素材生成」。新建的节点、没有这个字段的老节点都是它。
- **asset（素材）**：一份独立的资源，没有底部输入框，**人拖线连不进去**（左边连接点不画，落在节点身上也拒绝）。
- **形态是存的，不是推导的**：只经 shared 的 `nodeFormOf(type, data)` 读，字段缺失一律算 generate；老数据不迁移、不按 `src` 反推。body 只按 `src` / `poster` 画，和形态无关；`hasNodeResource` 只表示「有没有素材」。
- **只有两处会改形态，都在 `@shadecn/shared/flow-ops` 里、和引起它的改动同一个事务（一步撤销）**：
  1. **挂上素材**（`attachAsset`：上传完成，或 agent 带着 `src` 新建）：此刻**没有连入的线**（`target` 是它的边；连出去的不算）→ 成 asset；有连入 → 保持 generate。
  2. **被连入**（任何一条新边落到它身上，`insertEdge`）：asset → 改回 generate。人拖线连不进 asset，所以这一条在交互上只会由 agent、或下面的竞态触发。
  - 其余都不改：删掉连入的线不会变回 asset；复制节点连形态一起抄。
- **已知竞态（不修）**：本地上传时判定「没有连入」，同一时刻别人连了一条线进来 —— 两边合并后是「asset + 有连入」。读的一侧不回写文档；下一次连入或上传会把它纠正过来。

另外两条不可新建：`process` 是认不出的 `type`（老画布、已经下线的 `image-config` / `text-input` 等旧业务类型）的兜底外观，`group` 由打组围出来。底部输入框写 `data.prompt`、回车发 `composer:submit`，眼下**没有谁消费它**（四种类型都没启用 `runnable`）。**`src` / `poster` 只是地址字符串，值是对象存储（S3）的原始地址**，见下面「资源上传」。

**资源上传**。图片 / 视频节点**没有资源时**，占位上有一个上传按钮（点开文件选择，`image/*` / `video/*`）：

- 文件经后端转存到 S3（见 4.7），浏览器不接触存储的 AK/SK；回包里的 `url` 原样写进节点 `data`（`store.attachAsset` → `ops.attachAsset`，一步撤销），**同一步按「有没有连入的线」定形态**（见上面「两种形态」）：没有连入的上传完就是素材，有连入的仍是生成节点。
- **大文件分片上传**：分片大小 8 MiB（`ASSET_PART_SIZE`，前后端同一个常量）。不超过一片的一次传完；超过的切片上传 —— 浏览器最多 3 片并发，每片遇到网络错误或 5xx 重试 2 次（4xx 不重试），全部传完再拼成一个对象。中途彻底失败就放弃这次上传（S3 删掉已传的片），提示上传失败。后端同样按 S3 原生的分片上传往存储写，单个请求和后端内存都不超过一片。
- **桶里分目录**：对象键为 `<S3_KEY_PREFIX>/assets/<uuid 前 2 位>/<uuid 第 3–4 位>/<uuid><ext>`。前缀默认 `canvas`；所有素材进同一个 `assets/` 目录，**不按项目、画布、类别分**；按 uuid 拆两级目录，文件均匀散开，不会堆在同一层。早先的键是 `projects/<projectId>/flows/<flowId>/<images|videos>/…`，那些已上传的对象和画布里存的地址原样保留、不迁移；只有新上传的进新目录。
- **显示直接用 S3 原始地址**（`<endpoint>/<bucket>/<key>`，path-style），不经后端转发 —— 所以桶要对匿名开放读。这里的 `<endpoint>` 是公开地址 `S3_ENDPOINT`；服务端自己发的请求（上传、读字节给 agent 看图）可以另走内网地址 `S3_INTERNAL_ENDPOINT`，不影响存进节点、给浏览器的地址（REQ-DEPLOY §3.3）。改为私有桶、按成员判权读取的方案见 [REQ-ASSET-PRIVATE](25-private-asset-access.md)（规划中）。
- 视频：上传前先在浏览器里从本地文件截一帧（约 0.1s 处）当预览图，和视频一起传，`src` / `poster` 一次写入；截不出来（格式不认、超时）就只写 `src`，body 显示「暂无预览图」。
- **上传中**：占位上不再显示「暂无…」和上传按钮，换成进度 —— 分片上传是进度条 + 百分比（按传完的片累计，拼对象前才到 100%；视频只算视频本身，预览图不计），一次传完的没有中间进度，只转圈；节点的角标区挂「上传中」。两种都有「取消」：断开正在发的请求，分片的顺带放弃这次上传（S3 删掉已传的片），节点什么都不写，不提示失败，占位回到原样。**「上传中」是本地状态，不进文档**：别的协作者看不到，刷新页面就没了（写进文档的话，上传的人中途关掉页面，节点就永远卡在上传中）。
- 只在空占位上有入口：已有资源的节点不提供替换 / 删除；也没有拖放上传、粘贴上传。
- 没配齐对象存储（见 `.env.example` 的 S3 段）时上传回 503、toast 提示，不影响别的功能。删节点不删 S3 上的对象。

**端口与 inputs**。端口声明在注册表里：`inputs?: PortDef[]`、`outputs?: PortDef[]`，`PortDef = { id, dataType: 'text' | 'image' | 'video' | 'audio' | 'any', label?, multiple?, max? }`，另有一个看数据的钩子 `hasResource(data)`（上表第三列），和一个声明 `forms`（这个类型有没有 generate / asset 两种形态，只有图片 / 视频有）。四种类型的端口：

| type | 输入（都可接多条、不限条数） | 输出 | 输入开放条件 |
|---|---|---|---|
| `text` | 无 | `text` | — |
| `image` | `text`、`image`、`video` | `image` | generate 形态；asset 形态只对**人拖线**关闭（逻辑上照样能连，连上即改回 generate） |
| `video` | `text`、`image`、`video` | `video` | 同上 |
| `director` | `image`、`text` | `image`（截图）、`video`（录制） | 一直开放 |

**端口不画成多个连接点**：画布上每个节点最多左边一个进、右边一个出，**都不带 id**。端口只决定这一侧有没有连接点、能连什么、连上之后是哪对：**一个端口都没声明的类型**（兜底的 process、group）左右各一个，和谁都能连；**没有输入的**（text）不画左边；**输入此刻关着的**（asset 形态的图片 / 视频）左边也收起（`hasSide(type, side, data)`，带着节点数据判形态）。已经连着的线不受影响 —— 读的一侧从不回写文档，只是新线连不进去。

**连线只有一个方向：从出口（右）拉到入口（左）。** 入口 `connectable-start=false`（Vue Flow 的官方开关），从它拉不出线，也没有加号；出口 `connectable-end=false`，别的线落不到出口上。

连线关系表（起点 → 终点，选中的端口对；完整的「4 种类型 × 资源 × 形态」矩阵 —— 逻辑门、交互门各一张 —— 钉在 `packages/shared/test/flow-node-types.test.ts`，shared 的 `FLOW_NODE_TYPE_DEFAULTS` 上有同一张表）：

| 起点 \ 终点 | text | image（generate） | video（generate） | director |
|---|---|---|---|---|
| text | ✗ 没有输入 | text → text | text → text | text → text |
| image | ✗ | image → image | image → image | image → image |
| video | ✗ | video → video | video → video | ✗ 导演台不收视频 |
| director | ✗ | image → image（截图）；连过再连落到 video → video（录制） | 同左 | image → image |

连线有两道门，**不互斥**：

- **逻辑门**（`resolveConnection`）：只按上表配端口，**资源、形态都不看**。agent 的 `connect` / `add_node(connectFrom)` 和 `flow-ops` 只过这一道，所以 agent 能连进 asset 节点，连上时它改回 generate。
- **交互门**（shared 的 `interactionGate`，基于 `hasSide`）：人拖线时先问它 —— 终点是 asset 形态的 image / video 一律拒绝（「是素材，不接受连入」），再过逻辑门。拉线途中的 `is-valid-connection`、松手建边（含落在节点身上）、出口候选菜单都先问它。
- 起点是什么形态、有没有资源都不影响。

- **连线是唯一的事实源，端口存在边的 data 上**：`edge.sourceHandle` / `targetHandle` 一律为 `null`，`edge.data.sourcePort` / `targetPort` 存端口 id，多输入端口里的序号存 `edge.data.index`（`connectionEdgeData` 写这三项；两端都没声明端口的连线一项都不写，一侧没声明就只写有的那一侧）。序号取该端口现有最大 index + 1（`nextInputIndex`），**删线不重排** —— prompt 里写的「图片2」指的就是 index 为 2 的那条，删掉 1 号之后它不能漂成 1。两个人同时往同一个端口连线可能拿到同一个序号，排序时按边 id 兜底，结果仍然确定。
- **`inputs` 是派生的，不存**：所有 `target === 该节点` 的可见边，按 (端口, 序号) 排序，`port` 取 `data.targetPort`，`value` 取上游 `runtime.outputs[data.sourcePort]`。服务端 / agent 一次性派生（`readNodes` → `withInputs`）；编辑器**增量**派生（`createNodeProjector`，见 3.7.3）。
- **连哪对端口是自动选的，由 shared 的 `resolveConnection` 一个纯函数说了算**：前端拉线时的 `isValidConnection`（挂在 `Handle` 的 `is-valid-connection` 上）、拉线松手真正建边、从出口长出新节点、agent 的 `connect` / `add_node(connectFrom)` 全部调它。它的上下文除了 `typeOf` 和已有的边，还**必须**给 `dataOf(nodeId)`（节点的业务 data）—— 同一个上下文也喂交互门，必填免得哪个调用方漏掉形态这条。规则：两端存在且不是同一个节点；起点要有输出、终点要有输入（`declaresSide`）；在 **(源节点的输出端口 × 目标节点的输入端口)** 里按注册表声明顺序（源在外层）找**第一对**数据类型兼容（没声明端口的一侧算一个 `any`）、目标端口没满（`multiple` 不限条数，`max` 限条数；眼下的类型都是不限条数的多输入）、且这对之间还没有线的；找不到就拒绝这条线，原因按「类型不兼容 / 端口已满 / 都连过了」报最接近能连上的那条。agent 可以用 `sourcePort` / `targetPort` 显式指定，指定了就只校验那一对。例：导演台 → 图片先落 image → image，那对连过之后再连一条就落 video → video；同一个文本连同一张图第二次被拒（这对已经有线），另一个文本照样能连进来。**它不能挂在 `<VueFlow>` 的全局 `isValidConnection` 上**：Vue Flow 每次同步边都会拿全局那个把所有边校验一遍，判不过的直接不渲染，而「端口已满」拿已有的边去判必然判自己不合法。
- **从出口「长出」新节点**（点出口上的加号 / 从出口拉线到空白处松手）：**不自动建**，先弹一个候选类型菜单（`FlowGrowMenu.vue`，reka-ui 的 `DropdownMenuContent :reference` 锚在那个连接点 / 松手那一点，位置由它算）。菜单只列 shared 的 `connectableNodeTypes(sourceId, context)` 认可的类型 —— 按 `CREATABLE_NODE_TYPES` 的顺序、把每种当作**全新的空节点**去试 `resolveConnection`（`resolveGrowConnection`）；一种都没有时给一条置灰的「没有可连接的节点」。选一种才建：节点和线进同一个事务（`ops.createConnectedNode`），摆位并进同一条撤销，一次撤销两样都拿掉；Esc / 点别处关掉，什么都不建。入口没有加号、拉不出线，所以没有「往回长」。
- **拉线松手落在另一个节点身上**（没对准它左边的入口）也算连到它：和落在入口上同一条路（`connectNodes`：先过交互门 —— 落在素材身上照样拒绝 —— 再由 `resolveConnection` 选端口），连不上就提示原因、不建边，也不弹菜单；落回起点自己身上什么都不做。

底部工具栏**不按这张表铺一排按钮**：类型会越加越多，一整排图标既认不出来也放不下。新增节点收成**一枚加号**，点开是一个**类型菜单**（`ADDABLE_NODE_TYPES` = `CREATABLE_NODE_TYPES`：文本 / 图片 / 视频 / 导演台，名字和图标取自注册表；分组只能从选区打组，兜底类型不可新建）。没指定类型时建哪种由 `NEW_NODE_TYPE` 说了算（`addNode()` 的默认值）—— 当前是**文本节点**（正文存在 `data.text`，名字在 `metadata.label`，所以一个人改标题、另一个人改正文不会互相盖掉）。注意它和 `FALLBACK_NODE_TYPE`（`process`，认不出的 `type` 按它渲染）是两件事，后者必须和 `fromYNode` 的兜底值一致，否则老画布会换一副样子。

**业务字段为什么平铺、不再包一层 `config`**：Y.Map 的合并粒度是 key。`config` 整块存成一个 key 时，甲改 `config.prompt`、乙同时改 `config.model`，后到的那次会把整块盖掉 —— 明明改的是不同字段。平铺之后每个业务字段各占一个 key，逐键合并才真正成立（[REQ-COLLAB](04-realtime-collab.md) 4.0 那条「该不该活过刷新」的划分不变）。代价是索引签名让拼错的字段名不再报类型错，这是弱 schema 的固有代价，换来的是加一种节点不用改类型定义。

**运行态是每个节点都有的一组，不是某一类节点的私有配置**：画布不只是画出来的图，节点将来要真的跑起来（生成、上传、转换），运行态属于框架层。`duplicateNode` 复制 type / layout / metadata / data（含形态 `data.form`），**runtime 重置为 idle 且不带产出**（复本还没跑过），**连线一条都不复制**。

#### 3.7.1 一批会被各改各的元素：平铺分键，而不是往 Y.Doc 里加结构

功能越加越复杂，迟早有节点要装**一批元素**而不是几个标量 —— 3D 场景里的一串角色和机位、时间轴上的一堆轨道和关键帧、一个资源列表。把它们塞进 `data` 的**一个**键（`data.scene = { objects: [...] }`）会让这批元素共用一个合并单位：甲摆角色 A、乙同时摆角色 B，后到的那次整块盖掉。这和 v1 把业务字段裹在 `config` 里是同一个 bug，只是下沉了一层。

**做法：`data` 仍然是一层 Y.Map、值仍然全是普通 JSON，把这批元素摊成 `<前缀>.<id>` 这样一串平级的键。** 工具在 `@shadecn/shared/flow-collection`（`packages/shared/src/flow-collection.ts`，前端和 agent 共用；`collectionKey` / `readCollection` / `spreadCollection` / `collectionKeys`），写和删同笔落库走 `store.writeNode(id, 'data', { set, remove })`。

**为什么不是把 `scene` 变成嵌套的 `Y.Map`**（那样合并粒度最细，一次改动的 update 只有几十字节）：因为它把**结构**搬进了 CRDT 层。Y.Doc 没有版本号，新老客户端会同时往同一个 key 上写**不同的类型**——实测两个方向都跑过：赢家由 clientID 决定（等于随机），输家的整棵子树直接消失，而且输的那一方的代码当场 `TypeError`。这不是「读不懂就透传」能兜住的：读时兼容只对**形状**有效，对**类型**无效。平铺分键则对 CRDT 层完全不可见——`toYNode` / `fromYNode`（含服务端那份）一行不用改，`duplicateNode` 照跑，服务端连知道都不用知道，老客户端读到一堆不认识的键原样透传。所谓 schema 退化成一个**命名约定**，而命名约定的版本兼容就是普通的读时兼容（换前缀就两个都认一段时间）。

实测（导演台样例，`data` 43.7KB、15 个 3D 对象、17 条轨）：

| | 改一个元素要广播 | 两人改不同元素 | doc 体积 | 解码后内存 |
|---|---:|---|---:|---:|
| 整批塞一个键 | 26,626 B | ❌ 必然覆盖 | 33,394 B | 112 KB |
| **平铺分键** | **3,358 B** | ✅ 都在 | 35,065 B（+5%） | 128 KB（+14%） |
| 嵌套 Y.Map（不采用） | 25 B | ✅ 都在 | 44,857 B（+34%） | ~450 KB |

三条硬规则：

- **一个 key 的类型，从它第一次被写入起就固定，永远不能改。** 这是上一段那个结论的准确形式 —— 被禁的是「把一个已经是 plain 的 key 升级成 Y 类型」，因为那正是版本偏斜的成因。反过来，**一个从来没 plain 过、一上来就是 `Y.Text` 的新 key 是安全的**：老客户端 `toJSON()` 读到一个字符串，原样透传，永远不会在那个 key 上写 plain，两边不会在同一个 key 上写不同类型。所以平铺分键的值默认是普通 JSON，而真要字符级协同文本时，出路是**新开一个 key**，不是改老 key 的类型（见 3.7.2）。
- **id 必须稳定，不能是下标。** 下标会因别人的增删而错位，写就打到别人身上。源数据没有 id 就先补一个（`createId()`）—— 样例里 `scene.objects` 15 个有 5 个没 `uuid`，`keyframes` 整个没有 id，`spreadCollection` 遇到取不出 id 的元素直接跳过而不是拿下标顶上，就是这个原因。
- **前缀之间不许嵌套**（`dc.obj` 和 `dc.obj.pose` 会撞键：`dc.obj` + `pose.x` 和 `dc.obj.pose` + `x` 是同一个字符串）。目前只有约定，没有运行时防护。

粒度**拆到「一个元素一个键」为止**，不必再往元素内部拆。两个人同时改同一个元素仍然只剩一边，这一格**当前不管**——和画布上其余元素一样（[REQ-COLLAB](04-realtime-collab.md) 4.0.1：谁都可以并发编辑，节点上只*显示*还有谁在碰它）。要收窄它，答案在占用/提示这一侧而不是更细的 CRDT；而且真要做，优先做**软提示**（「张三正在编辑，改动可能互相覆盖」，`presence.occupantsOf` 已经能用）或**提交时检测**，而不是把元素变只读——只读那条路要处理租约、TTL、断线泄漏，还有 Vue Flow 的 `Object.assign` 合并陷阱（标志必须显式写 `true` 也写 `false`，否则锁解除后元素永久死掉），成本和这一格的价值不成比例。

**投影侧要留意的一点**：平铺分键会让 `data` 的 key 数量涨上去（一个导演台 42 个），而每个 key 在 `Flow.graph` 那份 JSON 投影里都要把前缀重写一遍。测过的是 Y.Doc 二进制（753 节点 1.98MB → 2.36MB），**JSON 投影侧还没量过**，而它的上限是 `GRAPH_LIMITS.bytes` = 2MB，参考样例已经 1.45MB。超了不是灾难（`deriveProjection` 跳过本次写入、留上一份，列表计数变旧，内容一字不受影响），但这是平铺分键引入的一条压力，真做导演台时补个测量。

#### 3.7.2 连续变化的值：本地草稿 + 一次提交

拖滑杆、拖 gizmo、拖关键帧、连续输入文本 —— 这些一次手势会产生几十上百个中间值，而**只有落点是数据**。

**规则：本地草稿全程接管画面；想让别人看见就把草稿节流发到 awareness；只在手势结束时写一次文档，前后 `separateUndo()` 夹住。**

**没有「松手」的那类（就地改标题、写正文）不用自己写这套样板**，用 `useDraftField`（`apps/web/src/composables/flow/useDraftField.ts`）：

```ts
const title = useDraftField<string>({
  current: () => props.label,                 // 当前已落库的值
  normalize: (raw) => raw.trim() || null,     // null = 放弃这次提交（标题被清空是误操作）
  commit: (next) => store.writeNode(props.nodeId, "metadata", { set: { label: next } }, "修改节点标题"),
  focus: () => inputRef.value?.select()       // 已经等过 nextTick，只给时机不给行为
})
```

节点组件里不用直接写这一段：`useFlowNode(id).draft(组, 键, { fallback, normalize, focus, label })` 就是它在某组某键上的封装（改名 `RenameTitle`、文本节点的正文 `TextBody`、底部输入框 `PromptComposer` 都是这么来的）。

它吃掉的正是那三件样板：草稿 ref、`editing` 开关、以及**提交时前后各一次 `separateUndo()`**；顺带挡住两种白写（值没变、`normalize` 判否）和一种重复提交（**回车和失焦常常连着触发**，`commit()` 第二次进来时 `editing` 已经是 false）。`TextBody.vue`（正文，不 trim、允许清空）、`RenameTitle.vue`（标题，trim、拒绝空）和 `PromptComposer.vue`（提示词）是它的消费者。

有「松手」的那类（拖节点、将来拖滑杆）目前仍是手写的，参考 `useFlowCanvas.ts` 的 `onNodeDragStart` / `onNodeDrag` / `onNodeDragStop`：草稿由 Vue Flow 内部状态 + `dragOrigin` 承担，中间态经 `publishDrag()` → `presence.setTransform()` 发出去，落点在 `onNodeDragStop` 提交。**它和 `useDraftField` 只差一步**——把 `draft` 节流发到 awareness；那一步没有做进 composable，因为它需要一个新的 awareness 反馈字段（现有的 `transform` 只装 `{x, y}`），而目前还没有这样的消费者。真要接的时候在组件里 `watch(draft, useThrottleFn(publish, 40))` 即可，`start` / `commit` / `cancel` 三段不用改。

**为什么不是「节流着写文档」。** 成本不在文档体积上 —— 实测拖 60 帧，doc 只从 33,411 涨到 33,438（Yjs 对 Map key 覆盖的 GC 很干净），代价**全在广播和落库**（同样 60 帧要广播 1.59MB，还要一路进服务端 `onStoreDocument` 的落库防抖）。节流到 10Hz 能砍掉大部分，但砍不掉两笔：**语义**（拖到一半的值不该活过刷新、不该能被撤销到；标签页中途崩了它会被当成有意的结果存下来）和**投递保证用反了**（awareness 是有损的 last-writer-wins，正合中间态；文档更新是保证投递 + 有序 + 合并，拿它送「可以随便丢」的东西是白付）。

**「合并成一条撤销」靠的不是捕获窗口。** `Y.UndoManager` 的 `captureTimeout` 是 400ms，中间停顿超过它就会裂成两条。所以两个样板都是**显式提交一次 + 前后 `separateUndo()`**，不依赖窗口兜底。

##### 中间态发 awareness 的四条

1. **这是一个新的反馈信号，不要复用 `transform`。** 现有 `transform` 的值类型是 `PresencePoint`（`{x, y}`），`ElementKind` 只有 `node` / `edge`；骨骼角度、四元数、时间的形状都不一样。按 [REQ-COLLAB](04-realtime-collab.md) 4.0 那条，加一个反馈信号的代价是「一个 setter + 一个 computed」，key 用 `node:<id>/dc.obj.<uuid>` 这种带子路径的形式。
2. **只发正在变的那几个数，别发整个元素。** 限帧只管住频率，包大小是正交的另一维，而 awareness 是**广播**：10 人房、2 个人在拖、25fps，一包 `{x,y}`（~100B）是 45KB/s，一包整个 3D 对象（4.8KB）是 **2.16MB/s** —— 同样人数差 48 倍。**先压包大小，再考虑降帧率**：降帧率伤跟手感，压包大小不伤任何东西。
3. **手势结束必须清干净。** awareness 的 local state 每 15s 会被 y-protocols 全量重播一次（`outdatedTimeout / 2`，也正是靠它撑住连接不超时），草稿留着不清就是每人每 15 秒重播一份废数据，人越多越贵。`clearTransform()` 除了清还**绕过节流立刻发一次**，这个细节也要照抄。
4. **节流两端都要开。** `useThrottleFn(fn, ms, trailing, leading)` —— leading 保证第一帧立刻发、跟手，trailing 保证窗口末尾补发。**trailing 不能省**：awareness 是 last-writer-wins 的**状态**而不是事件流，所以丢中间的包完全无害（最后一包携带完整当前状态），但**丢最后一包就是错的**。

   也正因为是状态而非事件，降帧率**只损失流畅度、不损失正确性** —— 真正不能丢的那些（落定的位置、提交的值）根本不走这条路，走的是 Y.Doc。这条性质就是「窗口跟着人数走」能成立的前提：`ms` 是个 getter（`feedbackThrottle(roomSize)`，在 `apps/web/src/lib/presence.ts`），VueUse 的过滤器每次调用都 `toValue(ms)` 重读，所以人进人出时窗口自动跟着变、不用重建节流函数。`FEEDBACK_THROTTLE_ROOM`（6 人）以内返回基础窗口 `FEEDBACK_THROTTLE`（60ms，光标、选中、拖动几何、拉线共用一个缓冲一个节流，值没变不发） —— 真实房间基本都在这一档，**行为和以前完全一样**；再多就阶梯放大，封顶在 `FEEDBACK_THROTTLE_MAX`（约 6fps，再稀对方的光标看着就像卡死了，那还不如别发）。

   ⚠️ **这条曲线是判断，不是实测出来的**，而且如上一条所说它是**二阶**的 —— 包大小的影响能压过它一个量级。真要调，改那三个常量一处即可。

##### 本地拖动期间，面板要读草稿，不能读投影

这是 `useFlowCanvas.ts` 那条「拖动期间不重建 `:nodes` 数组」规则的翻版：拖动中投影里那个值是**旧的**（中间态本来就没进文档），而别人的任何一次改动都会触发投影重算 —— 面板要是从投影读，你手上的滑杆会在队友打字时跳回文档值。

##### 文本要按字段分三档

文本和数值有一处不对称：**丢失的代价不同**。滑杆被覆盖是丢一次拖动，重拖即可；文本被覆盖是丢一整段，而且丢得无声无息。更要紧的是**草稿期间什么都没落地** —— 没进文档，自然也没进 y-indexeddb，标签页崩了就是全没，而同一张画布上别的改动都活着。

1. **短文本、原子语义**（标题 / 名字 / 标签）—— 现状就够，blur 提交。编辑窗口通常几秒。
2. **长文本、编辑时长以分钟计**（prompt / 说明）—— 加**停手防抖提交**（如 800ms），把崩溃损失从「整段」压到「最后一句」。代价要认：防抖间隔 > `captureTimeout` 的 400ms，所以每次提交都新起一条撤销，两分钟输入 ≈ 150 条。**持久化频率和撤销粒度此消彼长**，选哪头是产品判断，没有两全的写法。
3. **真要字符级合并**（两人同时写同一段）—— 平铺分键做不到，它只能整段覆盖，那是 `Y.Text` 的活。按 3.7.1 那条硬规则，它必须是**一个全新的、从来没 plain 过的 key**。**而且 `duplicateNode` 必须一起改**：它走「读出来（`fromYNode`）→ 深拷贝 → `toYNode`」（`@shadecn/shared/flow-ops` 的 `duplicateNode`），读出来的 `Y.Text` 已经 `toJSON()` 成字符串了，写回去就是个 plain string —— **复制出来的副本会悄无声息地失去字符级合并**。

##### 有些东西连 awareness 都不用进

播放头位置、面板高度、当前视图这类：不需要让别人看见就是纯本地（`FlowUserState` 或 localStorage），既不进文档也不进 awareness。只有「想让队友看到我在看第几秒」才值得占一个 awareness 字段。运行态（`status` / `error`）同理 —— 它是任务的状态不是用户的编辑，进了文档就进撤销栈，Ctrl+Z 会「撤销」掉一个任务状态。

**运行时状态不落库**：`selected` / `dragging` / `dimensions`（自动测量出来的尺寸）/ 校验结果，这些由 Vue Flow 或前端自己维护，序列化时必须剔除。**边上的 `sourceX/sourceY/targetX/targetY` 尤其不能存** —— 那是 Vue Flow 每帧回写到边对象上的渲染坐标，`toObject()` 不剥它，节点一动就是过期脏数据（参考实现里它占了 edges 体积的三分之一）。本项目的投影是白名单式的（`fromYEdge` 只读认识的字段），天然不会带上它。

#### 3.7.3 投影与节点组件：增量 inputs、Vue Flow 映射、基础组件

**store 投影分两步**（`apps/web/src/stores/flow/`）：`projectMap` 按 `observeDeep` 点名的键增量重读出 `FlowNodeRecord`，再由 `createNodeProjector`（`apps/web/src/lib/flow-projection.ts`）补上派生的 `inputs`。节点数组在**边那一步**才定稿 —— 只改一条边时节点记录一个都没变，但下游的 inputs 变了，它得换新对象。

**inputs 的失效范围**：一个节点换新对象只有两种原因 —— 它自己的记录变了（inputs 能复用就复用），或它的 inputs 变了。后者只取决于 ① 连进它的边（按目标分桶后和上一轮逐个比引用；端口和序号都在边的 data 上，改了边就是新对象 —— 增删、改端点、改端口、改序号、端点节点没了都会让桶变样）和 ② 上游的 `runtime.outputs`（只有记录真的换了、且产出**按值**变了的上游才算 —— 改上游的名字、拖上游的位置不波及下游）。所以受影响的是「变了的节点 + 入边变了的节点 + 产出变了的节点的直接下游」，其余一律原样交出上一轮的对象；每轮按 id 走一遍是 O(N + E) 的引用比较，**解析**只发生在受影响的那几个上。

**交给 Vue Flow 的形状**（`apps/web/src/components/flow/node-view.ts` 的 `toVueFlowNode`）：layout 摊到顶层，其余四组装进 Vue Flow 的 `data`（`{ metadata, data, runtime, inputs }`）。映射按投影对象 WeakMap 缓存，所以投影保住的引用到 Vue Flow 这一层也还在；布局键一律显式写出（没有就是 `undefined`），因为 Vue Flow 合并节点用 `Object.assign`，缺键会留着旧值。`useFlowCanvas` 的 `localDragging` 冻结照旧：本地拖动期间整个数组原样交回上一轮的（`computed` 的 `previous`）。

**节点 = 一个宿主 + 一份类型声明 + 若干能力**（详见 [REQ-NODEKIT](21-node-kit.md)）。Vue Flow 收到的每个 type 都是同一个组件 `node-kit/NodeHost.vue`；「这种节点长什么样」写在 `node-types.ts` 的类型声明里（`view`：body 组件、卡片还是框、尺寸、选中样式、底色、兜底名），「这种节点能做什么」是它按名字启用的能力（`features`）：框外名字 + 双击改名（`rename`）、复制 / 删除（`duplicate` / `delete`，单选时浮在上方的工具条）、连接点（`connectable`，挂 `FlowNodeHandles`：最多左右各一个、不带 id，按端口声明决定画不画哪一侧）、`runtime.status` 的展示（`status`：processing 一圈高亮 + 「运行中」角标；error 红框 + `runtime.error`）。宿主只管区域的几何与露出规则和选中态，**不认识任何具体类型或能力**，没有 `if (type === 'group')` —— 分组的差异全在它的声明里（`frame` 外壳、不启用连线 / 复制 / 删除、启用解组 / 拉伸 / 顶部把手）。公共逻辑在 `useFlowNode(id)`（`apps/web/src/composables/flow/useFlowNode.ts`，部件里经 `useNodePart().node` 拿到）：**直接读 store**（`store.nodeById`）而不是 Vue Flow 塞进来的 `data` prop —— 后者在本地拖动时是冻结的；按组写走 `store.writeNode`，草稿走 `useDraftField`。四种可新建的类型各自往 `body` 区登记自己的内容展示（`TextBody` / `ImageBody` / `VideoBody` / `DirectorBody`），往 `composer` 区按类型登记底部输入框（`definePromptComposerPart`，文本有了正文就收起，图片 / 视频看形态 —— generate 有、asset 没有 —— 导演台一直有），编辑模式来自能力 `edit-prompt`。`output-preview` / `runnable` 仍是登记着的通用能力，眼下没有类型启用。

### 3.8 边（`FlowEdge`）

```ts
interface FlowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null  // 一律 null：节点的连接点不带 id
  targetHandle?: string | null  // 同上；渲染时也强制按 null 交给 Vue Flow
  type?: string                 // 'default'（贝塞尔曲线），渲染时统一按曲线走
  animated?: boolean
  label?: string
  data: {
    createdAt?: number          // UTC epoch 毫秒
    sourcePort?: string         // 起点的输出端口 id；起点没声明端口时不写
    targetPort?: string         // 终点的输入端口 id；终点没声明端口时不写
    index?: number              // 在目标端口里的序号（从 1 起），有 targetPort 才有，删线不重排
    /** 和节点一样平铺 */
    [key: string]: unknown
  }
}
```

> 边的 `data` 原样透传。v1 的边 `data`（`{kind?, condition?, config}`）不再拆平，读出来就是它存的样子。

### 3.9 没有操作日志 —— 也没有历史

这一节经历过两轮删减，留着是因为「为什么没有」比「有什么」更容易被重新提出来。

> **第一轮：自定义操作模型被 Yjs 取代。** 原本是 `FlowOp { type, targetId, before, after }` +
> `FlowTransaction`，每条操作自带逆操作，撤销靠 `before`/`after` 互换后重放，前端有一张
> `commands/` 注册表按 `type` 查表执行。Yjs 接管之后整套删除 —— 撤销是 `Y.UndoManager` 的事，
> 它自己知道怎么逆；语义化的 `type` 也不再需要，因为服务端不重放操作、只存字节。
>
> **第二轮：字节流日志本身也删了。** `FlowOperation` 曾经存每次 Yjs 事务的更新二进制 +
> 服务端在握手时认定的 `actorId`，配 `GET /api/flows/:id/operations` 出元信息。移除的理由：
> 产品里从来没有回放或恢复入口，而这张表**只增不减**，是全库唯一随编辑次数线性增长的东西 ——
> `Flow.ydoc` 有 Yjs 的 GC 收敛（被覆盖的值内容被回收、相邻墓碑合并），它没有。

由此产生的三条现状，都是有意接受的代价：

- **没有「谁改了什么」。** Yjs 自己只认 `clientID`（一个随机数），服务端在握手时认出的用户身份
  现在只用于鉴权，不落库。想加回追责能力，就是重新引入一张表，先想清楚它服务于哪个界面。
- **没有历史，误删无法恢复。** 协作者（或被移出项目但还没被踢下线的人）一次 `deleteSelection()`
  清空画布，剩下的人也救不回来 —— `Y.UndoManager` 的 `trackedOrigins` 只跟踪自己的
  `LOCAL_ORIGIN`，别人的改动从来不进你的撤销栈。
- **真要补，形态是画布版本快照，不是逐条更新流。** 快照必须存 **ydoc 二进制**：从 `graph` JSON
  重建文档会分配全新的 clientID，和客户端手里的本地状态（内存 doc / IndexedDB 缓存）撞车，
  实测会随机丢掉一半离线编辑。「恢复到某版本」也要走当前文档上的一次事务，而不是重建文档。

仍然成立的两条约定：

- 客户端生成的 id（节点 / 连线）统一走 `apps/web/src/lib/id.ts` 的 `createId(prefix)`，形如 `<前缀>_<时间戳 base36>_<随机段>`。随机段不能省：两个客户端可能在同一毫秒各加一个节点，只靠时间戳会撞出同一个 id，在 CRDT 里就会被合并成同一个对象。
- **拖动的中间态不进文档**：一次拖拽只在 `onNodeDragStop` 提交落点，途中的位置走反馈层（awareness）。否则拖一下就是几十次更新。
- `viewport` 的变化**不是内容**：不进文档、不进撤销、不涨 `revision`，走的是 3.5.1 那条「按用户存」的路。

### 3.10 数据库模型（新增六张表）

> 下面是这批表**最初设计时**的 Prisma 写法，字段和约束的语义至今没变；数据层换成 MikroORM 之后，
> 现行定义在 `apps/server/db/entities/canvas.ts`（外键变成了关系属性：`projectId` → `project`，
> 列名按 `UnderscoreNamingStrategy` 变成 `project_id`；`FlowOperation` 那张表后来已整体移除）。

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

/// 一张画布。内容的事实源是 ydoc，graph 是它的只读投影。
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
  userStates FlowUserState[]

  @@index([projectId, deletedAt, updatedAt])
}

/// 画布上「属于某个人」的视图状态：视口，以后还有面板开合、个人偏好…
/// 按 key 分区存 JSON 字符串 —— 加一种要存的东西 = 加一个 key，不用改表。
/// 合法的 key 与各自的校验在 apps/server/store/flow-types.ts 的 FLOW_USER_STATE_PARSERS。
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
```

> 这里原本还有第六张表 `FlowOperation`（每次 Yjs 事务一行：更新二进制 + `actorId` + `serverTs`）。
> 连同它的 `GET /api/flows/:id/operations` 一起移除了，理由见 §3.9。

`User` 上要补两条反向关系：`memberships ProjectMember[]` 与 `createdProjects Project[] @relation("ProjectCreator")`。

**为什么只存全量状态、不存更新流**：进房间读全量状态是 O(1)，存更新流则要重放全部历史才能开一张画布。曾经两个都写（更新流作为可追责的旁路），但那条旁路没有任何界面消费，又只增不减 —— 见 §3.9。写入时机在 [REQ-COLLAB §3.7](04-realtime-collab.md)：散场 + 10 秒防抖 + SIGTERM 三个点。

## 4. 功能需求

### 4.1 项目列表（画布工作区的页内侧栏）

> 原先的独立列表页 `/projects` 已并入工作区：个人画布与项目共用一个界面（`CanvasWorkspace`），左侧页内侧栏第一项是「个人画布」（`/canvas`），其下「项目」分组列出项目，分组标题行有「+」新建项目，项目行 hover 出现删除图标（仅管理员）；内容区保留搜索与新建画布。下面的条目描述的是列表本身的行为，现在由侧栏承载（一次取 100 个，不分页）。

- 应用的落地页，卡片或表格形态都行，展示：项目名、描述、成员数、画布数、我的角色、更新时间。
- 分页：默认每页 20；页码写进 URL query。
- 只列出**我是成员**的项目 —— 没有「所有项目」视图，也没有公开项目。
- 顶部「新建项目」：填名称后创建，创建者自动成为该项目的 admin 成员（`ProjectMember` 里要真实写入这一行，不能靠 `createdById` 隐式推断，否则成员列表和权限判断得处处特判）。
- 空态要给出引导：「你还没有项目 —— 新建一个，或让同事把邀请链接发给你」。
- **这里只列项目**。个人画布（[REQ-SOLO](16-personal-flow.md)）是工作区侧栏的第一项、另一个页面（`/canvas`），不在项目主页里用 Tab 并列 —— 理由见 [REQ-SOLO §4.8](16-personal-flow.md)。个人空间本身是一个 `kind='personal'` 的项目，但**不出现在项目列表里**。

### 4.2 项目主页（`/projects/:id`）—— 一个界面统一展现

**不做多页面**。进入项目后就一个界面：固定的项目头部 + 下方**同页 Tab**（`画布` / `成员`）。**Tab 切换不改变路由**，也不触发页面级 loading —— 两个 Tab 的数据在进入项目时就各自请求好，切换只是显隐。

**项目头部**（常驻，不随 Tab 切换）
- 项目名与描述；admin 可就地编辑。
- 右侧操作：`分享`（仅 admin）。
- **删除项目只在工作区页内侧栏的项目行上**（hover 出现的删除图标，仅 admin，二次确认，软删），项目头部不放删除按钮。删的正是当前打开的项目时，删完跳到 `/canvas`。

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

> `AppSidebar.vue` 的布局与行为都不动 —— 只是把导航项里的「VueFlow」换成指向 `/canvas` 的「画布」（在 `/canvas` 与 `/projects/*` 下都高亮）（`/vue-flow` 那个 demo 路由本身保留，只是不再挂在菜单上）。

- 进入时 `GET /api/flows/:id` 取的是**文档元信息 + 我自己的 `userState`**；画布内容随即由 `flow:<id>` 房间的首次同步送达（见 [REQ-COLLAB §4](04-realtime-collab.md)）。视口优先用 `userState.viewport`，没有才退到 `graph.viewport` 兜底，再没有就 `fitView`。
- 沿用 [REQ-FLOW](09-flow-chart.md) 的全部交互（滚轮平移、Ctrl+滚轮以光标为锚点缩放、自定义节点、连线）。
- 空白处左键的行为由底部工具栏的**指针模式**决定（框选 / 拖动画布），中键任何时候都能拖画布。此外**按住空格键**是临时的拖动手势：按住期间左键在哪按下（含节点上）都是平移画布、光标变抓手、节点暂时不可拖，松开立刻回到原来的模式 —— 模式按钮的高亮不跟着变，因为它是手势不是模式。
- 节点（以及多选后的选区框）平时是普通指针，不是手型；按住拖动的过程中才变抓手，松手还原。
#### 4.4.1 悬浮胶囊工具条（左上角）

页面没有应用菜单，编辑器自己的入口收在**左上角一枚悬浮胶囊**里，浮在画布之上（圆角、半透明背景 + 模糊、与画布内容有明显层次）。从左到右三段：

1. **Logo（home）** —— 点击**回到这张画布来的那个列表**。它是这个页面唯一的「回去」入口，所以必须一眼可辨。

   落点按画布的 `mode` 走，**不按它挂在哪个项目下**：项目画布回 `/projects/:projectId`，个人画布回 `/canvas`（[REQ-SOLO §4.8](16-personal-flow.md)）。个人空间在库里确实是个项目、`meta.projectId` 也确实指着它，但那是存储上的事实——照着它跳，个人画布会落到一个摆着成员、分享、「全部项目」的项目主页上，而那三样对个人空间全是 403。图标和文案（`返回项目` / `返回个人画布`）跟着同一个判断走，和侧栏那两个入口用同一对图标。
2. **画布名** —— 就地编辑；新建未命名时显示占位「无标题」。名字右侧跟一个克制的状态指示，不抢视线。**它指示的是「同步」不是「保存」**：`已同步` / `同步中…` / `连接断开，改动将在重连后同步`。没有「未保存」和「保存失败，点击重试」这两种状态了 —— 改动即刻广播，用户无事可做，所以断线只提示、不给按钮。
3. **菜单按钮** —— 点开下拉：

   | 菜单项 | 行为 |
   |---|---|
   | 新建画布 | 在**同一项目**下新建并直接跳过去；跳之前先 flush 攒着的视图状态（内容不用管，它一直是同步的） |
   | 复制 | 调 `duplicate`，成功后跳到副本 |
   | 删除 | 二次确认后软删，然后回到上面那个落点（删之前算好——删完了再问「它是哪种画布」就晚了） |
   | 返回画布首页 | 回到 `/projects/:projectId`，与点 logo 等价（给一个带文字的显式出口） |

- 四个角的分工：左上标题胶囊 + 在场头像；左下视图控件；右上画布 Agent 对话框（对话气泡按钮，面板往下展开；左边一枚分享按钮，目前只是占位、没有动作）；底部正中工具栏。
- 视图控件和底部工具栏同一种圆角胶囊：只有缩放（`−` 百分比 `+`，百分比可直接输入，回车 / 失焦生效、Esc 放弃）、全览、自动布局、小地图显隐四样；小地图**默认不显示**，打开后是挂在开关按钮正上方的浮层（Popover），点外面 / Esc 不收起，只有再点按钮才关。**撤销 / 重做没有按钮**，只走快捷键。视图控件除自动布局外只管「怎么看」，胶囊只放「这张画布是什么、拿它怎么办」，画布内的编辑动作归底部工具栏。
- **自动布局**（视图控件里的按钮，`canvas.autoLayout()`）：dagre 横向分层（`LR`，纯函数在 `@shadecn/shared/flow-layout`，agent 的 `auto_layout` 用同一个），**只排顶层节点** —— 分组整体当一个框，连到组内节点的线按它所在的分组计。它是一次内容修改：所有新位置一笔 `moveNodes` 写进文档，**一次布局 = 一条撤销**，照常同步给协作者；排完 `fitAll` 全览。本地正拖着节点时不排。
- 底部工具栏右侧、胶囊外面单独一枚深色圆钮是 agent 快捷输入（✨ 图标；右上角对话框的按钮是浅色的对话气泡，两者一深一浅好区分）：弹出一个和对话框同款的输入框（含 @ 提及），发出去就**开一个新会话**执行，右上角对话框随之展开显示这一轮；已有一轮在跑时锁住发送。选中了节点时，它和对话框的「新会话」输入框开头自动带上每个选中节点的提及（REQ-AGENT §3.10.9）。两个入口共用同一份 agent 状态（`composables/flow/agent-panel.ts`，由 `FlowEditor.vue` provide）。
- **没有属性面板**：点节点不弹出任何侧栏，选中只是选中。节点的编辑入口都长在节点自己身上 —— 双击名字改名，选中时节点上方浮出工具栏（复制 / 删除）。原来那块右侧面板（label / description / config 的表单）连同「面板展开时右上角控件组左移让位」的布局一起去掉了：画布本身才是主角，为一个表单常驻挤掉三分之一画面不划算；真要编辑 `data.config` 这类结构化字段，将来按 `kind` 出**就地**的编辑形态，而不是把画布推到一边。
- **选中是「单独选中」**：点一个、拖一个、框选一片、点空白清空，全由 Vue Flow 那一份选中态说了算，我们只投影出「现在轮到哪个节点」（恰好选中一个时才有值）。所以节点工具栏同时**最多只出现一个** —— 上面的复制 / 删除都是对单个节点说的，框选一片时不出现。自己再维护一份选中态是不行的：拖动一个节点也会换选中态，而拖动之后那次 click 被 d3-drag 吞掉，于是「先点 A 再拖 B」会让两个节点头上同时挂着工具栏。
- **拉框的命中规则：节点必须被完全框住**（`selection-mode=Full`，也是 Vue Flow 的默认值）。蹭到一个角就算命中的话，框扫过谁就选中谁，想只挑出那几个节点会非常难。命中节点**相连的边一并算选中**（边跟着它的端点走），并且用主题色画出来 —— 默认主题给选中边的是 `#555`，压在同样是灰的线色上根本看不出来，那等于没标。
  - 这条「边跟着端点」的规则我们自己重申了一遍，没有全指望 Vue Flow：它拿上一帧的边集合和这一帧比，相等就一条变更都不发，而按下时的 `removeSelectedElements()` 只清了元素上的选中态、没清它那份缓存 —— 于是**连续框选两次、两次命中同一条边**时，第二次那条边会一直停在没选中。只在拉框期间生效：点选一条边本身会清空节点选中态，那时再套这条规则会把刚点中的边取消掉。
- **拉框过程中只有高亮，没有工具栏**：框每长一点就重算一次命中，节点高亮**逐个实时翻转**（框住就亮、缩回去就灭）；但节点头上那条（复制/删除）和选区那条（打组）在拉框期间一律不出现 —— 框扫过第一个节点时它会短暂地成为「唯一选中」，按钮于是闪一下又消失；选区那条则会跟着还在变的外接矩形一路乱跳。**松开鼠标才出现**。
- **框选一片时浮出的是另一条：选区工具栏**（`FlowSelectionToolbar`，浮在这片节点的外接矩形上方）。分工就是「对一个说的」和「对一片说的」：选中恰好一个 → 节点自己头上那条（复制 / 删除），选中两个及以上 → 选区那条，两者永远不会同时出现。目前上面只有一个动作：**打组**。
  - **分组是围着已经选好的一片节点长出来的**，所以底部工具栏里没有「添加分组」：先凭空建一个空框、再把节点一个个拖进去，顺序是反的，而且「拖进分组自动归属」还没做，那条路根本走不通。
  - **分组的外壳和普通节点是同一套**（宿主 `NodeHost` + 能力 `rename`）：名字贴在框**外**的左上角、双击改名，选中时工具栏浮在正上方居中 —— 和文本节点长得一模一样，只是那排按钮换成了分组自己的（没有「复制」，只有一枚**解组**）。解组拆掉的只有这个框，组里的节点原地留下 —— 所以它既不用垃圾桶图标也不用 destructive 的红色（`Ungroup` 图标 + 普通 ghost 按钮）：那两样都在说「东西要没了」，而这一下什么都没丢，撤销一次还能原样回来。名字曾经长在框**内部**的标题栏上，那让分组看着像另一种东西，可它只是个 body 不一样的节点；画布上「这块叫什么」应该只有一种表达。
  - 名字挪出去之后，**拖动没法跟着挪**：`NodeToolbar` 是 teleport 到画布容器上的，在名字上按下鼠标不会传到节点的 d3-drag。所以分组在自己顶边留了一条**通栏 24px 的把手**（平时不画出来，指上去才浮出底色，光标是 move），位置正是原来标题栏所在的地方。代价是这条带子里起不了框选 —— 分组整块 `pointer-events-none` 换来的画布穿透，在这 24px 上要让给拖动。
  - 框的大小是选中节点的外接矩形加一圈留白（顶上多留一条给那条把手）。已经在别的分组里的节点、以及分组框本身不参与（换爹会把它从原来的框里抠出来；嵌套分组的层级和坐标要另说一套），剩不下两个就把按钮置灰。
  - **分组框和成员的归属写在同一个事务里**：分开写的话，会有一瞬间成员的 `parentNode` 指着还不存在的节点 —— Vue Flow 当场报 `NODE_MISSING_PARENT`，这些节点的位置被当成相对一个不存在的父节点，整片跳到画布原点附近；撤销也会撤出个只剩半拉的中间态。
  - **「不许拖出框」（`extent: 'parent'`）照样写在这一笔里，但要等父节点量出尺寸之后才交给 Vue Flow**（`useFlowCanvas` 的 `extentReady`）：Vue Flow 算这个边界用的是父节点的 `dimensions`，而分组框刚出现在画布上时尺寸还是 0 —— 边界退化成一个点，每个成员当场被夹到「框左上角减去自己宽高」的位置，一片节点全叠到框外面去。
  - **这道门必须开在「交给 Vue Flow 之前」，不能靠「晚一点再写文档」**。晚写只保得住打组的人自己：收到同步的那一方是直接从文档里读 `extent` 的，读到就立刻夹，而那时新的分组框在他那边还没渲染。**「打组没同步给别人」实际上就是这个** —— 数据完好地到了，是接收方的视图把它夹坏了。文档里的坐标自始至终是对的，所以刷新一下就好，也因此特别容易被当成同步问题。

#### 4.4.2 编辑器的拆分方式

**编辑器不是一个大组件**：`FlowEditor.vue` 只负责建上下文和摆组件，功能分在两层。

- **hooks 层（`apps/web/src/composables/flow/`）** —— `provideFlowEditor(props)` 建一份共享 payload 并 `provide` 出去，子组件 `useFlowEditor()` 取用，**不逐层传 props**。里面是三个各管一摊的 composable：
  | composable | 管什么 |
  |---|---|
  | `useFlowDocument` | 加载元信息、改名、新建/复制/删除、同步状态文案、离开前 flush 视图状态 |
  | `useFlowSync` | **这一条 WebSocket 连接**（传输在 `sync/collab.ts`）：房间 `flow:<flowId>`，交出 `doc`（给 store）和 `awareness`（给 presence） |
  | `useFlowCanvas` | Vue Flow 绑定：拖动 → `store.moveNodes`、连线 → `store.addEdge`、视口同步、Ctrl+滚轮缩放、新增节点、打组、自动布局 |
  | `useFlowSelection` | 「现在轮到哪个节点」（Vue Flow 选中态的**投影**，恰好选中一个时才有值，决定节点工具栏露不露） |
  | `useFlowPresence` | 反馈层：上报光标/选中/拖动几何，读别人的 |
  | `useFlowSnapping` | 拖动时的网格 / 辅助线吸附（见 4.4.3），两者都常开、无开关、无持久化状态 |
  依赖是一条直线：`selection`/`sync` → `presence` → `canvas`，只有 `useFlowCanvas` 同时认识这三者。另有 `useFlowShortcuts(ctx)` 管快捷键和离开前的 flush；上下文里还带着节点扩展协议的运行时 `nodeKit`（注册表、编辑模式、动作执行器）。
- **组件层（`apps/web/src/components/flow/`）** —— 一块界面一个组件，各自直接读上下文：`FlowCanvas`（画布本体，留了 `<slot/>` 给画布内浮层）、`FlowViewControls`（左下角视图控件：缩放 / 全览 / 自动布局 / 小地图）、`FlowTitleCapsule`（左上角胶囊，自带删除确认）、`FlowToolbar`（底部工具栏，胶囊右侧独立挂 agent 快捷输入 `agent/FlowAgentQuickPrompt`）、`agent/FlowAgentChat`（右上角 agent 对话框）、`FlowSelectionToolbar`（框选一片时浮在选区上方的工具栏，目前放「打组」）、`node-kit/NodeHost.vue`（每种节点共用的宿主：外部名字标签、单独选中时浮在正上方的工具栏、底部输入框、右侧预览等区域的位置和露出时机都由它说了算；各区域里挂什么由类型声明和能力注册，见 [REQ-NODEKIT](21-node-kit.md)）、`TextBody` / `ImageBody` / `VideoBody` / `DirectorBody`（类型的 body，只管自己长什么样）、`FlowGrowMenu`（从出口长出新节点的候选类型菜单），`FlowSnapGuides`（拖动时的对齐辅助线），以及协同带来的三个：`FlowPresenceBar`（头像栏）、`FlowPresenceAvatar`、`FlowPresenceCursors`（别人的光标与正在拉的线）。

判据：**加一块新面板 / 新工具按钮，不应该需要改 `FlowEditor.vue` 或任何中间层** —— 新建组件、`useFlowEditor()` 取上下文、挂到模板上即可。
- 快捷键：`Ctrl/Cmd+Z` 撤销、`Ctrl/Cmd+Shift+Z` 重做、`Delete` / `Backspace` 删除选中。单独选中一个节点时，它工具条上动作的快捷键也生效（复制 `Ctrl/Cmd+D`、解组 `Ctrl/Cmd+Shift+G`，写在按钮的提示里）；编辑器自己的这几个键先判，节点动作抢不走。**`Ctrl/Cmd+S` 只是拦住浏览器的「保存网页」对话框**，本身不再有任何含义 —— 没有要保存的东西。
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
- **吸附只作用在拖动上，不去动已经摆好的节点。** 所以没有用 Vue Flow 自带的 `:snap-to-grid`：它除了拖动，还会在**节点挂载时**（`NodeWrapper` 的 `clampPosition`）把位置对到格子上 —— 那是一次只发生在本地视图、不进文档的位移，开着吸附的人和没开的人看到的画布从此不一样。两种吸附收在同一个函数（`apps/web/src/lib/flow-snap.ts`，纯几何、可单测）里算，结果只有一个位移。
- 吸附发生在 `onNodeDrag` 里、Vue Flow 写完位置之后：它每帧都从**指针位置**重新算一遍节点位置，所以这一下修正不会累加到下一帧 —— 手移开对齐线，吸附自然松开。落点仍然只在 `onNodeDragStop` 一次性进文档，中间态照旧不落库（见 4.5）；上报给协作者的拖动几何是**吸附之后**的位置，否则别人看到的是没吸住的那个。

### 4.5 Pinia store（`apps/web/src/stores/flow/`）

pinia 已装在 `devDependencies`（前端整体被打包进 `output/public`，服务端 runtime 不 import 它，符合仓库的依赖切分约定）。需要在 `apps/web/src/main.ts` 里 `app.use(createPinia())`。

> **store 是 Y.Doc 的投影，不是内容的持有者。** 原本它是事实源：自己维护 `nodes`/`edges`、
> 两个历史栈、一个 `pending` 提交队列和 `baseRevision`。现在内容住在 Y.Doc 里，
> store 负责的是「把文档映成 Vue 能渲染的数组」和「所有写都包成一个带 origin 的 Y 事务」。
> `undoStack` / `redoStack` / `pending` / `baseRevision` / `saveState` 全部不存在了。

store 的职责边界：

- **状态**：`meta`（FlowSummary 部分）、`nodes` / `edges` / `graphMeta`（**Y.Doc 的只读投影**，`observeDeep` 一变就重算）、`viewport`、`userState`、`canUndo` / `canRedo`、`lastLabel`。
- **唯一写入口**：所有内容变更都通过 `mutate(change, label?)`，它把改动包进一个带 `LOCAL_ORIGIN` 的 `doc.transact()`。组件**不许直接碰 Y.Map** —— 绕过去的改动既不进撤销、也不同步、更不落库。`label` 只给界面反馈用，CRDT 不需要它。
- **文档形状**（`@shadecn/shared/flow-doc`，前后端共用一份；服务端专属的只有 `apps/server/collab/flow-doc.ts` 里的 `readGraphFromDoc` / `pruneDanglingEdges`）：`nodes` / `edges` 是 `Y.Map<id, Y.Map>`，每个节点的 `data` 又是一层嵌套的 `Y.Map`。**这样分层是为了让 Y.Map 按 key 合并** —— 一个人改标题、另一个人同时拖位置能干净地合并；整个节点存成一个 JSON blob 的话，后写的那次会把先写的整体盖掉。
- **撤销 / 重做**：`Y.UndoManager`，`trackedOrigins: [LOCAL_ORIGIN]`。就是这一个选项让 `Ctrl+Z` **只撤自己的**，不碰协作者的改动。`separateUndo()`（`stopCapturing`）把本会并进 400ms 捕获窗口的两次操作拆成两条记录。
- **历史仍然只在内存里**：刷新即清空，撤销不跨会话；内容本身当然不丢。
- **没有保存、没有 revision、没有 409、没有 dirty state**：改动即刻广播，服务端订阅同一个文档并落库（[REQ-COLLAB §3.7](04-realtime-collab.md)）。
- **拖动的中间态故意不进文档**：只有 `onNodeDragStop` 的落点进 `mutate`，途中的位置走反馈层。否则一次拖拽就是几十次更新。
- **视图状态是另一条路**：`setViewport()` / `setUserState(key, 值)` 只改本地、**不发请求**，落库搭下一次本地编辑的车（见 3.5.1）。存失败不弹提示（丢了最多是下次打开回到上一个存住的视图），值留在队列里下次再发；`saveNow()`（离开前）会把它 flush 掉。
- Vue Flow 的双向绑定不能绕开 store：拖动结束（`nodeDragStop`）、连线建立（`connect`）、删除，都转成对 `mutate` 的调用。
- **拖动期间不许重建 `:nodes` 数组** —— Vue Flow 按数组引用决定要不要重新同步，而重新同步走的是 `Object.assign(existing, incoming)`；拖动中间态既然不进文档，`incoming.position` 就是拖动前的位置，节点会在手底下弹回去。`useFlowCanvas` 为此留了一个 `localDragging` 标志，详见 [REQ-COLLAB §4.0.2](04-realtime-collab.md)。

另有 `stores/project.ts`（当时的路径，现已不存在）持有当前项目与成员列表（供项目主页三个区域共享），职责简单，不涉及历史。

### 4.6 内容是怎么落库的

> **原本这里是 `POST /api/flows/:id/commit`**：body 带 `baseRevision` + 事务数组 + 客户端算好的全量 graph 快照，
> 服务端校验 `baseRevision === flow.revision`，不匹配就 409、让后来者重新加载。
> 它建立在「同一时刻只有一个编辑者」这个假设上，协同一上就整个失效了 —— 而且**必须**失效：
> 客户端手里的 graph 只是某一时刻的快照，拿它覆盖服务端就会抹掉同一秒里别人的编辑，
> 这正是 CRDT 要消灭的那个「后写覆盖先写」。**这个端点已经删除，前端没有任何提交动作。**

现在的路径是：

```
浏览器 ──Yjs update──▶ /ws/collaboration ──▶ Hocuspocus 房间 flow:<id> 的 Y.Doc
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
| POST | `/api/flows/:id/assets` | member | 一次传完一个画布资源（**不超过一片**，否则 413 提示分片）：multipart，字段 `file`，只收 `image/*` / `video/*`（否则 415）。**201** + `{ url, key, contentType, size }`（`UploadedAsset`，`url` 是 S3 原始地址）；没配存储 503，S3 写失败 502 |
| POST | `/api/flows/:id/assets/multipart` | member | 分片上传·开始。body `{ filename, contentType, size }`；类型不对 415，`size` 超过 `S3_MAX_UPLOAD_MB`（默认 100MB）413。**201** + `{ uploadId, key, partSize, partCount }` |
| PUT | `/api/flows/:id/assets/multipart/:uploadId/parts/:partNumber?key=` | member | 分片上传·传一片。请求体是这一片的原始字节（非空，不超过一片，否则 400 / 413）；`partNumber` 1..10000。回 `{ partNumber, etag }` |
| POST | `/api/flows/:id/assets/multipart/:uploadId/complete` | member | 分片上传·完成。body `{ key, parts }`，`parts` 必须从 1 起连续升序（否则 400）。**201** + `UploadedAsset`（大小、类型以 S3 上实际拼出来的为准） |
| DELETE | `/api/flows/:id/assets/multipart/:uploadId?key=` | member | 分片上传·放弃，S3 删掉已传的片，204 |
| PATCH | `/api/flows/:id/user-state` | member | 存**我自己**的视图状态（视口…），body 只带要改的分区，204。不涨 `revision`、不写更新流、没有乐观锁 |
| — | ~~`POST /api/flows/:id/commit`~~ | — | **已删除**，见 4.6。内容不再经过 HTTP |

分片上传**服务端不记会话**：`uploadId` + `key` 每一步由客户端带回来，`key` 必须落在这张画布的目录下、且是服务端拼出来的形状，否则 400 —— 成员不能借自己画布的权限往别的目录写。所以多副本下每一步落到哪个实例都行。

**上传记录**：每次上传成功（一次传完的在存进 S3 之后、分片的在 complete 之后），回包之前记一行「对象键 → 这张画布、服务端看到的类型、上传人」（`FlowAsset`）；记不下来整个上传算失败（500）。对象键本身看不出属于哪张画布，凡是客户端递来一个键、要确认它属于这张画布的地方都查它 —— 现在是 agent 消息的附件（[REQ-AGENT §3.10.12](20-agent-canvas.md)），以后私有访问判权（[REQ-ASSET-PRIVATE §3.3](25-private-asset-access.md)）也从它出发。

**画布内容走的不是 HTTP**：`ws://<host>/ws/collaboration`（房间 `flow:<flowId>` 走消息，不在路径里），握手时按项目成员身份鉴权（`apps/server/auth/ws.ts`），此后服务端还会持续确认这条连接的权限还在：**移除成员 / 删项目 / 删画布这三个接口会当场把受影响的 WebSocket 踢掉**（本实例立即，其它实例 ≤3 秒），另有每 20 秒一轮的复验兜底。所以「移除成员」对正在编辑的人不再有可观的窗口期——这很要紧，因为他在窗口期里改的东西会被 CRDT 合并落库，而留下的人**撤销不回来**（撤销只跟踪自己的操作）。踢下线时会区分「会话过期」和「不是成员了」，两者给用户的出路不同。协议与运行参数见 [REQ-COLLAB](04-realtime-collab.md)。

约定沿用 [REQ-DATA](05-data-persistence.md)：错误响应统一 `{ error: string }`；请求体非法 JSON → 400；参数校验在路由层，数据访问全在 `apps/server/store/projects.ts` 与 `apps/server/store/flows.ts`，路由文件里不出现任何数据库访问。

所有端点在 `/api/*` 之下，因此默认需要登录（[REQ-AUTH](02-auth-keycloak.md)）。

### 4.8 鉴权规则

- **画布的访问权完全由项目成员身份决定**，与 `Flow.createdById` 无关。
- `/api/flows/:id` 系列先按 id 查出 `projectId`，再查请求者是不是该项目成员 —— 这段判断收敛到一个中间件（如 `apps/server/auth/project.ts` 的 `requireProjectMember` / `requireProjectAdmin`），路由里不重复写。
- **非成员访问一律 404，不是 403**（不泄露项目/画布是否存在）。成员但权限不足（member 干 admin 的事）才是 **403**。
- 软删的项目 / 画布对所有人都等同于不存在（404）。**软删就到此为止**：不清理、不物理删除、不提供恢复入口 —— `deletedAt` 只是一道过滤条件，数据留在库里当兜底，真要捞得手工进库。
- 唯一的例外是 `/api/invites/:token` 两个端点：它们按 token 鉴权而非成员身份，只要求登录。

### 4.9 校验规则

- 项目 `name`、画布 `name`：非空字符串，trim 后 1..80 字符。
- `pageSize`：1..100 的整数，越界 → 400。
- 分享链接 `expiresInDays` 只接受 1 / 7 / 30。
- 单项目成员上限 200、画布上限 500，超出 → 400 并给出明确文案。
- `graph`：**没有任何接口接受它了**，所以不存在请求体校验。`parseGraph` 仍在 `apps/server/store/flow-types.ts` 里，用途变成两处**读**：把库里的老 `graph` JSON 灌进 Y.Doc 时（`bindState` 的迁移），以及列表页读投影时。读到坏数据的策略是**跳过而不是报错** —— 那是历史数据，拒绝它只会让画布打不开。
- `user-state`：body 必须是非空对象；**未登记的分区 key → 400**；每个分区按 `FLOW_USER_STATE_PARSERS` 里自己的规则校验（视口要求 `x`/`y`/`zoom` 都是有限数字且 `zoom > 0`）；单个分区序列化后 16KB 封顶。任一分区不合法就整体拒绝，不「对一半存一半」。
- 单个画布上限：**文档 20MB、单条消息 1MB**，拦在 WebSocket 那一层
  （见 [REQ-COLLAB §4.2](04-realtime-collab.md)）。**节点数和连线数不设上限** —— 那是产品判断不是护栏，
  规模由字节数一条管住。配额分两级：超**软限**只标记，写入照常（删回去自动解除 —— 否则谁也删不了东西，
  房间就死了）；顶到**硬限**（软限 × 1.25 = 25MB）才锁写，锁到散场重开。拒绝走连接 `readOnly`
  （NACK 不断连），绝不 `throw` —— throw 会让 Hocuspocus 关连接，超限房间对所有人不可达。
  投影（`Flow.graph` 那段 JSON）另有一道 2MB 的关，超过就跳过本次投影写入、留上一份，内容不受影响。
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
- [x] 列表接口的响应体里没有 `graph` 字段。（apps/server/test/routes/flows.test.ts）
- [ ] 从画布列表点开一张画布，落到 `/flows/:id` 独立整页：**没有侧边栏**、没有项目主页的分区，画布占满视口；退回项目主页后侧边栏恢复。
- [ ] 左上角悬浮胶囊显示 logo + 画布名 + 菜单按钮；点 logo，项目画布回所属项目主页、个人画布回 `/canvas`。
- [ ] 胶囊菜单四项都可用：新建画布落到同一项目下的新画布、复制落到副本、删除后回项目主页、「返回画布首页」与点 logo 去到同一处。
- [ ] 点「新建画布」跳走之前，攒着的视图状态先落库；内容不需要等待（它一直是同步的）。
- [x] 新建 → 编辑 → 刷新页面，节点、连线、视口全部还原。（浏览器回归）
- [ ] 连续做 5 步操作后按 5 次 `Ctrl+Z` 回到初始状态，再按 5 次 `Ctrl+Shift+Z` 完全恢复。
- [ ] 框选多个节点一起拖动，只需一次撤销即可整体回退。
- [ ] 撤销之后再做新操作，重做栈被清空（重做按钮变灰）。
- [ ] 刷新页面后撤销栈为空、撤销按钮变灰，但画布内容完好。
- [ ] 断网时继续编辑不报错；恢复连接后改动自动补同步，不需要用户做任何事。
- [x] 同项目两个成员同时打开同一张画布，**两边的改动都留下**（不同字段真合并），没有 409、没有「请重新加载」。（浏览器回归 + apps/web/src/test/stores/flow.test.ts）
- [x] 一方拖动节点时另一方在场：拖动过程中本地节点不会弹回原位（`localDragging`）。（浏览器回归）
- [x] 同一条 Yjs 更新被应用两次，画布上不会出现第二个节点。（apps/web/src/test/stores/flow.test.ts）
- [x] 删除键删掉的节点会同步给对方、也会落库（即没有绕开 store）。（浏览器回归）
- [x] 节点 `data` 上平铺的任意业务字段，存取一字不差。（apps/server/test/routes/flows.test.ts）
- [x] v1 / v2 写的老节点读出来不抛错：没有 metadata / runtime 的退化成缺省值（名字为空、状态 idle），老字段原样留在 `data` 里；`parseGraph` 照收布局平铺在顶层的老行。（apps/server/test/collab/flow-doc.test.ts、apps/server/test/store/flow-types.test.ts、packages/shared/test/flow-doc.test.ts）
- [x] 五组往返无损：`toYNode` → `fromYNode`，含 `runtime.outputs` 摊成 `outputs.<portId>` 扁平键、两个端口的产出并发更新互不覆盖。（packages/shared/test/flow-doc.test.ts）
- [x] 两个人同时改同一个节点的不同业务字段，两边的改动都留下 —— 平铺之后才成立的合并粒度；一人改 `metadata.label`、一人改 `data.prompt`，两边都留。（apps/web/src/test/stores/flow.test.ts）
- [x] `inputs` 派生：按 (端口, 序号) 排序、value 取上游产出、删线不重排；增量投影里只有受影响的节点换对象。（packages/shared/test/flow-graph.test.ts、apps/web/src/test/stores/flow.test.ts）
- [x] 自动选端口前后端同一套（`resolveConnection`）：声明顺序、数据类型、容量、已连过的跳过、无端口类型照旧可连；端口写在 `edge.data` 上、handle 为空。（packages/shared/test/flow-node-types.test.ts、apps/web/src/test/composables/flowCanvasPorts.test.ts、packages/agent/test/tools.test.ts）
- [x] 节点（宿主 + 默认注册表）：processing / error 的展示、分组不画连接点、改名经 `useFlowNode` 写到 `metadata.label`、分组解组、文本就地编辑。（apps/web/src/test/components/FlowNodes.test.ts、apps/web/src/test/components/node-kit/）
- [ ] 平移/缩放后刷新，视口回到离开时的位置；撤销按钮不会因为只挪了画布而变亮，撤销也拽不回视野。
- [x] **只平移不编辑时一个写请求都不发**；发生一次编辑后，攒着的视口立刻被顺路 PATCH 上去，之后的连续编辑合成一发在手停时补齐（一直不停手由 `maxWait` 顶上）。（apps/web/src/test/stores/flow.test.ts）
- [ ] 同一张画布两个人各自平移到不同位置，互不影响；第三个人第一次打开时按投影里的兜底视口（或 fitView）。
- [x] 一张 `ydoc` 为空的老画布被打开后，旧 `graph` JSON 的内容原样出现在画布上，且此后以 Y.Doc 为准。（apps/server/test/routes/flows.test.ts）
- [x] A 项目的成员访问 B 项目的画布 id 返回 404；未登录访问任一 `/api/projects*` / `/api/flows*` 返回 401；非项目成员连 `flow:<id>` 房间的 WebSocket 被拒。（apps/server/test/auth/ws.test.ts + routes 测试）
- [x] 一方伪造 awareness 里的身份，另一方看到的仍是服务端认定的真身；光标位置不受影响。（浏览器实测 + apps/server/test/collab/hardening.test.ts）
- [x] 节点 / 连线数超过上限后，房间被标记为拒绝写入；散场后重新判定。（apps/server/test/collab/hardening.test.ts）
- [x] 并发「删节点 + 连线」留下的悬空边在落库前被清掉，且不进任何人的撤销栈。（apps/server/test/collab/hardening.test.ts）

**测试覆盖**

- [x] `apps/server/test/routes/projects.test.ts` —— 创建即 admin、成员隔离 404、admin/member 权限分界 403。
- [x] `apps/server/test/routes/invites.test.ts` —— 幂等取链接、过期自动换新、改有效期不换 token、重置、预览、接受、多人复用、失效文案。
- [x] `apps/server/test/routes/flows.test.ts` —— 分页、校验、跨项目 404、**画布内容的写入路径（Yjs）**、duplicate、`user-state` 各存各的 / 覆盖 / 不涨 revision / 校验 / 非成员 404 / 随画布级联删除、`operations` 分页。
- [x] `apps/server/test/auth/ws.test.ts` —— WebSocket 握手鉴权：匿名拒、登录但非项目成员拒、成员放行并带出 `actorId`。
- [x] `apps/web/src/test/stores/flow.test.ts` —— Y.Doc 投影（写进得去、读得出来）、用第二个 `Y.Doc` 扮演协作者验证**同一节点不同字段的并发编辑真合并**、撤销只撤自己的、视口不进文档、视口只在本地编辑后才落库（五种请求形态）。
- [x] `apps/web/src/test/lib/presence.test.ts` —— 反馈层的纯逻辑：颜色哈希、防御式解析对端状态、占用仲裁（不带 socket）。
- ~~`apps/web/src/test/stores/flow-commands.test.ts` / `flow-sync.test.ts`~~ —— 随命令注册表与提交队列一起删除。

## 6. 本期不做

- ~~**多人实时协同编辑**~~ —— **已经做了**，见 [REQ-COLLAB](04-realtime-collab.md)。本文原本按单编辑者设计（没有在线状态、没有光标共享、没有合并策略，冲突只是「后写的人被拦下并重新加载」），那一套已被 Yjs 全面替掉。
- 编辑锁 / 抢占提示（「张三正在编辑这张画布」）。仲裁逻辑写好了也有测试，但**当前没接进画布**：谁都可以同时改同一样东西，由 CRDT 合并，节点标签上只是*显示*还有谁在碰它。要恢复限制见 [REQ-COLLAB §4.0.1](04-realtime-collab.md)。
- ~~**画布规模上限的强制**~~ —— **已经做了**，拦在 WebSocket 那一层（见 4.9 与 [REQ-COLLAB §4.2](04-realtime-collab.md)）。
- **多进程部署**：房间的 Y.Doc 只活在单个进程的内存里，所以仍必须 `replicas: 1`。
  换了 Hocuspocus 之后这条有了现成的路（`@hocuspocus/extension-redis`），但没有需求就没接。
- 历史版本 / 回滚 —— 现在连数据都没有了（见 §3.9）。要做得先设计版本快照，且快照存 ydoc 二进制而非 JSON 投影。
- 邮箱邀请、按用户名直接添加成员、加入申请与审批 —— **分享链接是唯一入口**。
- 一个项目多条分享链接、按人/按用途分发、使用次数上限、链接维度的加入记录。
- 转让管理员、多管理员之外的自定义角色、画布级别的细粒度权限（项目内成员平权）。
- 主动退出项目（先只有被 admin 移除）。
- 任何形式的操作审计（画布内的「谁改了什么」，以及项目层面的「谁改了项目名、谁移除了谁」）。
- 软删数据的清理任务与「回收站 / 恢复」入口 —— 删了就是删了，`deletedAt` 只过滤不回收。
- 撤销栈跨会话保留。
- 画布缩略图生成。
- 各节点类型的定制表单与字段合法性校验（服务端只透传，不解释业务字段）。
- **把节点拖进（拖出）已有分组时自动归属**（reparent）：数据上 `parentNode` / `extent` 已经通了，分组也能由框选打组产生、能拉伸、能改名、删框留节点，缺的只是拖动时的命中判定。
- 导入导出、导出图片。
- 视频节点的全屏 / 倍速 / 音量大小，以及移出后记住播放位置（当前 hover 播放与控制栏见 §3.7）。
- 资源的替换 / 删除、拖放与粘贴上传、断点续传（刷新页面后接着传）、协作者看到别人的上传进度、S3 上孤儿对象的清理（删节点、撤销上传都不删对象；客户端半路消失留下的残片靠桶的生命周期规则清）、私有桶 + 签名读地址、浏览器直传 S3（预签名地址）。
- 跨画布、跨项目的节点复制粘贴；画布在项目间移动。

## 7. 待确认事项

暂无 —— 前几轮提出的问题已全部拍板并写进上文：撤销栈不跨会话、不存操作日志也不做历史、项目主页用同页 Tab、软删不清理不恢复、侧栏用「画布」替掉原来的「VueFlow」入口。

实现过程中新冒出来的取舍，追加到这里。

**Yjs 改造带来的取舍（按发生顺序）**

1. **内容不再有「保存」**。用 CRDT 就不能再让客户端上传全量快照覆盖服务端 —— 那会抹掉并发的编辑。于是提交、`baseRevision` 乐观锁、409、「未保存」指示、`beforeunload` 拦截全部随之消失。想要一个用户可见的「保存」动作只剩一条正当路径：**显式快照 / 发版**（`Y.snapshot()`，需要 `YWS_GC=false`），那是给当前状态打标记，不是上传当前状态。还没做。
2. **`graph` 从事实源降级为投影**。操作日志则走完了「语义化操作 → 字节流 → 整个删掉」三步，最终连「谁改的」也不再记录（§3.9）。
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
