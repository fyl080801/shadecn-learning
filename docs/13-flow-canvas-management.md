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

加一个分区要动三处、都不改表：`src/types/flow.ts` 的 `FlowUserState` 加字段、服务端 `server/store/flow-types.ts` 的 `FLOW_USER_STATE_PARSERS` 加一条校验（**不认识的 key 一律 400** —— 这张表不是任意 KV）、前端 `store.setUserState('新字段', 值)`（攒批、失败重试、离开前落库都是现成的）。

**视图状态自己不发请求。** `setUserState` 只把值记在本地队列里，真正落库由 `noteLocalEdit()` 触发 —— 每次本地编辑（`mutate` / `undo` / `redo`）都会叫它一声，节奏是**先立刻发一次，再防抖收尾**：空闲之后的第一次编辑当场就走（leading，不等窗口），这之后的改动交给 `useDebounceFn`，手停下来 `USER_STATE_FLUSH_DELAY`（2s）补齐最后的状态，一直不停手则由 `maxWait`（`USER_STATE_FLUSH_MAX_WAIT`，10s）顶上去。于是：只看不改的一次访问**零写流量**；一串连续操作合成开头一发加收尾一发；**没有哪次改动被丢掉**。纯防抖不行是因为它有滞后（手不停就一直不发，而这趟还兼着会话心跳，见下），纯节流又会把窗口内最后那截改动整个丢掉。只有一次编辑时收尾那发发现没东西可送，不会白跑一趟。这条设计的由来：画布内容改走 Yjs 之后，视口若还自己起定时器，它就成了整个编辑器**唯一**的周期性 HTTP 请求 —— 看一眼画布就一路 PATCH 上去。

**这一趟 PATCH 同时是会话的心跳，所以窗口到点时一定发**：视图一次都没动过的话，就把当前视口当作要存的东西发出去。内容走 WebSocket 之后编辑本身不再产生任何 HTTP，而会话的空闲计时只认真实请求，服务端的协同复验又是只读的、特意不续期（[REQ-COLLAB](04-realtime-collab.md) 4.2）—— 少了这一发，一个人可以边正常编辑边被判空闲登出。合起来是一条完整的规则：**在编辑 = 每个窗口一次 PATCH = 会话续着；只看不改 = 零请求 = 该超时就超时。**

### 3.6 图内容（`FlowGraph`）—— Y.Doc 的只读投影

```ts
interface FlowGraph {
  schemaVersion: 2                       // 结构版本，后续结构调整靠它做兼容读取
  viewport: { x: number; y: number; zoom: number }
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** 画布级自定义数据，同样透传存储 */
  meta: Record<string, unknown>
}
```

> **v1 → v2 是就地升级，不是拒收。** v1 把业务种类放在 `data.kind`、业务字段裹在 `data.config` 里、`ports` 是每个节点都有的空壳；v2 把种类并进顶层 `type`、业务字段平铺到 `data` 上、每个节点带 `status`（见 3.7）。`parseGraph()` 读到 v1 会当场升级再返回，**这一条是硬要求**：存量 `Flow.graph` 全是 v1，而老画布进 Yjs 的唯一入口 `loadFlowState()` 靠 `readGraph()` —— 那里读不出内容就返回 `null`，等于第一次打开老画布就把它清空。Y.Doc 里的老节点没有版本号可查，靠形状认（同时有字符串 `kind` 和对象 `config`），只在**读**的一侧升级，纯函数、幂等、不回写文档：投影里写文档会凭空产生一次 Yjs 事务，进别人的撤销栈并广播出去。

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
  type: string                  // 业务种类，也是节点类型注册表的键，如 'process' / 'group'
  position: { x: number; y: number }
  width?: number                // 手动 resize 过才有
  height?: number
  zIndex?: number
  parentNode?: string           // 分组 / 子流程
  extent?: 'parent' | null
  sourcePosition?: 'left' | 'right' | 'top' | 'bottom'
  targetPosition?: 'left' | 'right' | 'top' | 'bottom'

  // —— 业务层：全部在 data 内 ——
  data: FlowNodeData
}

interface FlowNodeData {
  label: string                       // 节点标题
  status: 'idle' | 'processing' | 'completed' | 'error'
  createdAt?: number                  // UTC epoch 毫秒；老数据没有
  description?: string
  icon?: string                       // lucide 图标名
  /** 显式声明的输入 / 输出端口；不声明就是默认的单进单出 */
  ports?: { inputs: FlowPort[]; outputs: FlowPort[] }
  /** UI 状态里需要持久化的部分（折叠、备注颜色…） */
  ui?: Record<string, unknown>
  /** 业务字段**平铺**在这一层，前后端都不解释，原样透传存储 */
  [key: string]: unknown
}

interface FlowPort {
  id: string                    // 对应 Vue Flow Handle 的 id
  label?: string
  /** 数据类型标记，用于将来做连线合法性校验；本期只存不校验 */
  dataType?: string
}
```

**`type` 就是业务种类**，v1 里那个和它恒等的 `data.kind` 已经并进来了 —— 两个字段说同一件事，留着只会分叉。它同时是**节点类型注册表**（`src/components/flow/node-types.ts`）的键：由谁渲染、菜单里叫什么、新建时铺什么默认字段，全在注册表里一处说清楚，画布和 `addNode()` 都从那儿取。加一种节点只改注册表这一个文件，既有代码一行不动。

底部工具栏**不按这张表铺一排按钮**：类型会越加越多，一整排图标既认不出来也放不下。新增节点收成**一枚加号**，建哪种由 `NEW_NODE_TYPE` 说了算 —— 当前是**文本节点**（一张卡片，双击正文就地编辑；正文存在 `data.text`，自己占一个 key，所以一个人改标题、另一个人改正文不会互相盖掉）。注意它和 `FALLBACK_NODE_TYPE`（`process`，认不出的 `type` 按它渲染）是两件事，后者必须和 `fromYNode` 的兜底值一致，否则老画布会换一副样子。

**业务字段为什么平铺、不再包一层 `config`**：Y.Map 的合并粒度是 key。`config` 整块存成一个 key 时，甲改 `config.prompt`、乙同时改 `config.model`，后到的那次会把整块盖掉 —— 明明改的是不同字段。平铺之后每个业务字段各占一个 key，逐键合并才真正成立（[REQ-COLLAB](04-realtime-collab.md) 4.0 那条「该不该活过刷新」的划分不变）。代价是索引签名让拼错的字段名不再报类型错，这是弱 schema 的固有代价，换来的是加一种节点不用改类型定义。

**`status` 是每个节点都有的字段，不是某一类节点的私有配置**：画布不只是画出来的图，节点将来要真的跑起来（生成、上传、转换），运行态属于框架层。

#### 3.7.1 一批会被各改各的元素：平铺分键，而不是往 Y.Doc 里加结构

功能越加越复杂，迟早有节点要装**一批元素**而不是几个标量 —— 3D 场景里的一串角色和机位、时间轴上的一堆轨道和关键帧、一个资源列表。把它们塞进 `data` 的**一个**键（`data.scene = { objects: [...] }`）会让这批元素共用一个合并单位：甲摆角色 A、乙同时摆角色 B，后到的那次整块盖掉。这和 v1 把业务字段裹在 `config` 里是同一个 bug，只是下沉了一层。

**做法：`data` 仍然是一层 Y.Map、值仍然全是普通 JSON，把这批元素摊成 `<前缀>.<id>` 这样一串平级的键。** 工具在 `src/lib/flow-collection.ts`（`collectionKey` / `readCollection` / `spreadCollection` / `collectionKeys`），写和删同笔落库走 `store.writeNodeData(id, { set, remove })`。

**为什么不是把 `scene` 变成嵌套的 `Y.Map`**（那样合并粒度最细，一次改动的 update 只有几十字节）：因为它把**结构**搬进了 CRDT 层。Y.Doc 没有版本号，新老客户端会同时往同一个 key 上写**不同的类型**——实测两个方向都跑过：赢家由 clientID 决定（等于随机），输家的整棵子树直接消失，而且输的那一方的代码当场 `TypeError`。这不是「读不懂就透传」能兜住的：读时升级（`upgradeNodeData` 那套）只对**形状**有效，对**类型**无效。平铺分键则对 CRDT 层完全不可见——`toYNode` / `fromYNode`（含服务端那份）一行不用改，`duplicateNode` 照跑，服务端连知道都不用知道，老客户端读到一堆不认识的键原样透传。所谓 schema 退化成一个**命名约定**，而命名约定的版本兼容就是普通的读时兼容（换前缀就两个都认一段时间）。

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

**没有「松手」的那类（就地改标题、写正文）不用自己写这套样板**，用 `useDraftField`（`src/composables/flow/useDraftField.ts`）：

```ts
const title = useDraftField<string>({
  current: () => props.label,                 // 当前已落库的值
  normalize: (raw) => raw.trim() || null,     // null = 放弃这次提交（标题被清空是误操作）
  commit: (next) => store.updateNodeData(props.nodeId, { label: next }, "修改节点标题"),
  focus: () => inputRef.value?.select()       // 已经等过 nextTick，只给时机不给行为
})
```

它吃掉的正是那三件样板：草稿 ref、`editing` 开关、以及**提交时前后各一次 `separateUndo()`**；顺带挡住两种白写（值没变、`normalize` 判否）和一种重复提交（**回车和失焦常常连着触发**，`commit()` 第二次进来时 `editing` 已经是 false）。`TextNode.vue`（正文，不 trim、允许清空）和 `FlowNodeChrome.vue`（标题，trim、拒绝空）就是它的两个消费者。

有「松手」的那类（拖节点、将来拖滑杆）目前仍是手写的，参考 `useFlowCanvas.ts` 的 `onNodeDragStart` / `onNodeDrag` / `onNodeDragStop`：草稿由 Vue Flow 内部状态 + `dragOrigin` 承担，中间态经 `publishDrag()` → `presence.setTransform()` 发出去，落点在 `onNodeDragStop` 提交。**它和 `useDraftField` 只差一步**——把 `draft` 节流发到 awareness；那一步没有做进 composable，因为它需要一个新的 awareness 反馈字段（现有的 `transform` 只装 `{x, y}`），而目前还没有这样的消费者。真要接的时候在组件里 `watch(draft, useThrottleFn(publish, 40))` 即可，`start` / `commit` / `cancel` 三段不用改。

**为什么不是「节流着写文档」。** 成本不在文档体积上 —— 实测拖 60 帧，doc 只从 33,411 涨到 33,438（Yjs 对 Map key 覆盖的 GC 很干净），代价**全在广播和落库**（同样 60 帧要广播 1.59MB，还要一路进服务端 `onStoreDocument` 的落库防抖）。节流到 10Hz 能砍掉大部分，但砍不掉两笔：**语义**（拖到一半的值不该活过刷新、不该能被撤销到；标签页中途崩了它会被当成有意的结果存下来）和**投递保证用反了**（awareness 是有损的 last-writer-wins，正合中间态；文档更新是保证投递 + 有序 + 合并，拿它送「可以随便丢」的东西是白付）。

**「合并成一条撤销」靠的不是捕获窗口。** `Y.UndoManager` 的 `captureTimeout` 是 400ms，中间停顿超过它就会裂成两条。所以两个样板都是**显式提交一次 + 前后 `separateUndo()`**，不依赖窗口兜底。

##### 中间态发 awareness 的四条

1. **这是一个新的反馈信号，不要复用 `transform`。** 现有 `transform` 的值类型是 `PresencePoint`（`{x, y}`），`ElementKind` 只有 `node` / `edge`；骨骼角度、四元数、时间的形状都不一样。按 [REQ-COLLAB](04-realtime-collab.md) 4.0 那条，加一个反馈信号的代价是「一个 setter + 一个 computed」，key 用 `node:<id>/dc.obj.<uuid>` 这种带子路径的形式。
2. **只发正在变的那几个数，别发整个元素。** 限帧只管住频率，包大小是正交的另一维，而 awareness 是**广播**：10 人房、2 个人在拖、25fps，一包 `{x,y}`（~100B）是 45KB/s，一包整个 3D 对象（4.8KB）是 **2.16MB/s** —— 同样人数差 48 倍。**先压包大小，再考虑降帧率**：降帧率伤跟手感，压包大小不伤任何东西。
3. **手势结束必须清干净。** awareness 的 local state 每 15s 会被 y-protocols 全量重播一次（`outdatedTimeout / 2`，也正是靠它撑住连接不超时），草稿留着不清就是每人每 15 秒重播一份废数据，人越多越贵。`clearTransform()` 除了清还**绕过节流立刻发一次**，这个细节也要照抄。
4. **节流两端都要开。** `useThrottleFn(fn, ms, trailing, leading)` —— leading 保证第一帧立刻发、跟手，trailing 保证窗口末尾补发。**trailing 不能省**：awareness 是 last-writer-wins 的**状态**而不是事件流，所以丢中间的包完全无害（最后一包携带完整当前状态），但**丢最后一包就是错的**。

   也正因为是状态而非事件，降帧率**只损失流畅度、不损失正确性** —— 真正不能丢的那些（落定的位置、提交的值）根本不走这条路，走的是 Y.Doc。这条性质就是「窗口跟着人数走」能成立的前提：`ms` 是个 getter（`feedbackThrottle(roomSize)`，在 `src/lib/presence.ts`），VueUse 的过滤器每次调用都 `toValue(ms)` 重读，所以人进人出时窗口自动跟着变、不用重建节流函数。`FEEDBACK_THROTTLE_ROOM`（6 人）以内返回原来那个 40ms —— 真实房间基本都在这一档，**行为和以前完全一样**；再多就阶梯放大，封顶在 `FEEDBACK_THROTTLE_MAX`（约 6fps，再稀对方的光标看着就像卡死了，那还不如别发）。

   ⚠️ **这条曲线是判断，不是实测出来的**，而且如上一条所说它是**二阶**的 —— 包大小的影响能压过它一个量级。真要调，改那三个常量一处即可。

##### 本地拖动期间，面板要读草稿，不能读投影

这是 `useFlowCanvas.ts` 那条「拖动期间不重建 `:nodes` 数组」规则的翻版：拖动中投影里那个值是**旧的**（中间态本来就没进文档），而别人的任何一次改动都会触发投影重算 —— 面板要是从投影读，你手上的滑杆会在队友打字时跳回文档值。

##### 文本要按字段分三档

文本和数值有一处不对称：**丢失的代价不同**。滑杆被覆盖是丢一次拖动，重拖即可；文本被覆盖是丢一整段，而且丢得无声无息。更要紧的是**草稿期间什么都没落地** —— 没进文档，自然也没进 y-indexeddb，标签页崩了就是全没，而同一张画布上别的改动都活着。

1. **短文本、原子语义**（标题 / 名字 / 标签）—— 现状就够，blur 提交。编辑窗口通常几秒。
2. **长文本、编辑时长以分钟计**（prompt / 说明）—— 加**停手防抖提交**（如 800ms），把崩溃损失从「整段」压到「最后一句」。代价要认：防抖间隔 > `captureTimeout` 的 400ms，所以每次提交都新起一条撤销，两分钟输入 ≈ 150 条。**持久化频率和撤销粒度此消彼长**，选哪头是产品判断，没有两全的写法。
3. **真要字符级合并**（两人同时写同一段）—— 平铺分键做不到，它只能整段覆盖，那是 `Y.Text` 的活。按 3.7.1 那条硬规则，它必须是**一个全新的、从来没 plain 过的 key**。**而且 `duplicateNode` 必须一起改**：它走「投影 → `structuredClone` → `toYNode`」（`useFlowCanvas.ts` 的 `duplicateNode`），投影里 `Y.Text` 已经 `toJSON()` 成字符串了，写回去就是个 plain string —— **复制出来的副本会悄无声息地失去字符级合并**。

##### 有些东西连 awareness 都不用进

播放头位置、面板高度、当前视图这类：不需要让别人看见就是纯本地（`FlowUserState` 或 localStorage），既不进文档也不进 awareness。只有「想让队友看到我在看第几秒」才值得占一个 awareness 字段。运行态（`status` / `error`）同理 —— 它是任务的状态不是用户的编辑，进了文档就进撤销栈，Ctrl+Z 会「撤销」掉一个任务状态。

**运行时状态不落库**：`selected` / `dragging` / `dimensions`（自动测量出来的尺寸）/ 校验结果，这些由 Vue Flow 或前端自己维护，序列化时必须剔除。**边上的 `sourceX/sourceY/targetX/targetY` 尤其不能存** —— 那是 Vue Flow 每帧回写到边对象上的渲染坐标，`toObject()` 不剥它，节点一动就是过期脏数据（参考实现里它占了 edges 体积的三分之一）。本项目的投影是白名单式的（`fromYEdge` 只读认识的字段），天然不会带上它。

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
    createdAt?: number          // UTC epoch 毫秒
    /** 和节点一样平铺 */
    [key: string]: unknown
  }
}
```

> v1 的边 `data` 是 `{kind?, condition?, config}`。升级时 `config` 拆平，但 **`kind` / `condition` 保留**：它们和节点的 `kind` 不一样 —— 没有别的字段与之重复，是边自己的业务语义，丢了就真丢了。

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

- 客户端生成的 id（节点 / 连线）统一走 `src/lib/id.ts` 的 `createId(prefix)`，形如 `<前缀>_<时间戳 base36>_<随机段>`。随机段不能省：两个客户端可能在同一毫秒各加一个节点，只靠时间戳会撞出同一个 id，在 CRDT 里就会被合并成同一个对象。
- **拖动的中间态不进文档**：一次拖拽只在 `onNodeDragStop` 提交落点，途中的位置走反馈层（awareness）。否则拖一下就是几十次更新。
- `viewport` 的变化**不是内容**：不进文档、不进撤销、不涨 `revision`，走的是 3.5.1 那条「按用户存」的路。

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
```

> 这里原本还有第六张表 `FlowOperation`（每次 Yjs 事务一行：更新二进制 + `actorId` + `serverTs`）。
> 连同它的 `GET /api/flows/:id/operations` 一起移除了，理由见 §3.9。

`User` 上要补两条反向关系：`memberships ProjectMember[]` 与 `createdProjects Project[] @relation("ProjectCreator")`。

**为什么只存全量状态、不存更新流**：进房间读全量状态是 O(1)，存更新流则要重放全部历史才能开一张画布。曾经两个都写（更新流作为可追责的旁路），但那条旁路没有任何界面消费，又只增不减 —— 见 §3.9。写入时机在 [REQ-COLLAB §3.7](04-realtime-collab.md)：散场 + 10 秒防抖 + SIGTERM 三个点。

## 4. 功能需求

### 4.1 项目列表页（`/projects`）

- 应用的落地页，卡片或表格形态都行，展示：项目名、描述、成员数、画布数、我的角色、更新时间。
- 分页：默认每页 20；页码写进 URL query。
- 只列出**我是成员**的项目 —— 没有「所有项目」视图，也没有公开项目。
- 顶部「新建项目」：填名称后创建，创建者自动成为该项目的 admin 成员（`ProjectMember` 里要真实写入这一行，不能靠 `createdById` 隐式推断，否则成员列表和权限判断得处处特判）。
- 空态要给出引导：「你还没有项目 —— 新建一个，或让同事把邀请链接发给你」。
- **这一页只列项目**。个人画布（[REQ-SOLO](16-personal-flow.md)）是侧栏另一个入口、另一个页面（`/personal`），不在这里用 Tab 并列 —— 理由见 [REQ-SOLO §4.8](16-personal-flow.md)。个人空间本身是一个 `kind='personal'` 的项目，但**不出现在项目列表里**。

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

1. **Logo（home）** —— 点击**回到这张画布来的那个列表**。它是这个页面唯一的「回去」入口，所以必须一眼可辨。

   落点按画布的 `mode` 走，**不按它挂在哪个项目下**：项目画布回 `/projects/:projectId`，个人画布回 `/personal`（[REQ-SOLO §4.8](16-personal-flow.md)）。个人空间在库里确实是个项目、`meta.projectId` 也确实指着它，但那是存储上的事实——照着它跳，个人画布会落到一个摆着成员、分享、「全部项目」的项目主页上，而那三样对个人空间全是 403。图标和文案（`返回项目` / `返回个人画布`）跟着同一个判断走，和侧栏那两个入口用同一对图标。
2. **画布名** —— 就地编辑；新建未命名时显示占位「无标题」。名字右侧跟一个克制的状态指示，不抢视线。**它指示的是「同步」不是「保存」**：`已同步` / `同步中…` / `连接断开，改动将在重连后同步`。没有「未保存」和「保存失败，点击重试」这两种状态了 —— 改动即刻广播，用户无事可做，所以断线只提示、不给按钮。
3. **菜单按钮** —— 点开下拉：

   | 菜单项 | 行为 |
   |---|---|
   | 新建画布 | 在**同一项目**下新建并直接跳过去；跳之前先 flush 攒着的视图状态（内容不用管，它一直是同步的） |
   | 复制 | 调 `duplicate`，成功后跳到副本 |
   | 删除 | 二次确认后软删，然后回到上面那个落点（删之前算好——删完了再问「它是哪种画布」就晚了） |
   | 返回画布首页 | 回到 `/projects/:projectId`，与点 logo 等价（给一个带文字的显式出口） |

- 缩放 / 适应视图 / 锁定的控件组挪到**右上角**（[REQ-FLOW](09-flow-chart.md) 里它在左上角，这里和胶囊对调），**撤销 / 重做**也加进这一组 —— 胶囊只放「这张画布是什么、拿它怎么办」，不放画布内的编辑动作。
- **没有属性面板**：点节点不弹出任何侧栏，选中只是选中。节点的编辑入口都长在节点自己身上 —— 双击名字改名，选中时节点上方浮出工具栏（复制 / 删除）。原来那块右侧面板（label / description / config 的表单）连同「面板展开时右上角控件组左移让位」的布局一起去掉了：画布本身才是主角，为一个表单常驻挤掉三分之一画面不划算；真要编辑 `data.config` 这类结构化字段，将来按 `kind` 出**就地**的编辑形态，而不是把画布推到一边。
- **选中是「单独选中」**：点一个、拖一个、框选一片、点空白清空，全由 Vue Flow 那一份选中态说了算，我们只投影出「现在轮到哪个节点」（恰好选中一个时才有值）。所以节点工具栏同时**最多只出现一个** —— 上面的复制 / 删除都是对单个节点说的，框选一片时不出现。自己再维护一份选中态是不行的：拖动一个节点也会换选中态，而拖动之后那次 click 被 d3-drag 吞掉，于是「先点 A 再拖 B」会让两个节点头上同时挂着工具栏。
- **拉框的命中规则：节点必须被完全框住**（`selection-mode=Full`，也是 Vue Flow 的默认值）。蹭到一个角就算命中的话，框扫过谁就选中谁，想只挑出那几个节点会非常难。命中节点**相连的边一并算选中**（边跟着它的端点走），并且用主题色画出来 —— 默认主题给选中边的是 `#555`，压在同样是灰的线色上根本看不出来，那等于没标。
  - 这条「边跟着端点」的规则我们自己重申了一遍，没有全指望 Vue Flow：它拿上一帧的边集合和这一帧比，相等就一条变更都不发，而按下时的 `removeSelectedElements()` 只清了元素上的选中态、没清它那份缓存 —— 于是**连续框选两次、两次命中同一条边**时，第二次那条边会一直停在没选中。只在拉框期间生效：点选一条边本身会清空节点选中态，那时再套这条规则会把刚点中的边取消掉。
- **拉框过程中只有高亮，没有工具栏**：框每长一点就重算一次命中，节点高亮**逐个实时翻转**（框住就亮、缩回去就灭）；但节点头上那条（复制/删除）和选区那条（打组）在拉框期间一律不出现 —— 框扫过第一个节点时它会短暂地成为「唯一选中」，按钮于是闪一下又消失；选区那条则会跟着还在变的外接矩形一路乱跳。**松开鼠标才出现**。
- **框选一片时浮出的是另一条：选区工具栏**（`FlowSelectionToolbar`，浮在这片节点的外接矩形上方）。分工就是「对一个说的」和「对一片说的」：选中恰好一个 → 节点自己头上那条（复制 / 删除），选中两个及以上 → 选区那条，两者永远不会同时出现。目前上面只有一个动作：**打组**。
  - **分组是围着已经选好的一片节点长出来的**，所以底部工具栏里没有「添加分组」：先凭空建一个空框、再把节点一个个拖进去，顺序是反的，而且「拖进分组自动归属」还没做，那条路根本走不通。
  - **分组的外壳和普通节点是同一套**（`FlowNodeChrome`）：名字贴在框**外**的左上角、双击改名，选中时工具栏浮在正上方居中 —— 和文本节点长得一模一样，只是那排按钮换成了分组自己的（没有「复制」，只有一枚**解组**）。解组拆掉的只有这个框，组里的节点原地留下 —— 所以它既不用垃圾桶图标也不用 destructive 的红色（`Ungroup` 图标 + 普通 ghost 按钮）：那两样都在说「东西要没了」，而这一下什么都没丢，撤销一次还能原样回来。名字曾经长在框**内部**的标题栏上，那让分组看着像另一种东西，可它只是个 body 不一样的节点；画布上「这块叫什么」应该只有一种表达。
  - 名字挪出去之后，**拖动没法跟着挪**：`NodeToolbar` 是 teleport 到画布容器上的，在名字上按下鼠标不会传到节点的 d3-drag。所以分组在自己顶边留了一条**通栏 24px 的把手**（平时不画出来，指上去才浮出底色，光标是 move），位置正是原来标题栏所在的地方。代价是这条带子里起不了框选 —— 分组整块 `pointer-events-none` 换来的画布穿透，在这 24px 上要让给拖动。
  - 框的大小是选中节点的外接矩形加一圈留白（顶上多留一条给那条把手）。已经在别的分组里的节点、以及分组框本身不参与（换爹会把它从原来的框里抠出来；嵌套分组的层级和坐标要另说一套），剩不下两个就把按钮置灰。
  - **分组框和成员的归属写在同一个事务里**：分开写的话，会有一瞬间成员的 `parentNode` 指着还不存在的节点 —— Vue Flow 当场报 `NODE_MISSING_PARENT`，这些节点的位置被当成相对一个不存在的父节点，整片跳到画布原点附近；撤销也会撤出个只剩半拉的中间态。
  - **「不许拖出框」（`extent: 'parent'`）照样写在这一笔里，但要等父节点量出尺寸之后才交给 Vue Flow**（`useFlowCanvas` 的 `extentReady`）：Vue Flow 算这个边界用的是父节点的 `dimensions`，而分组框刚出现在画布上时尺寸还是 0 —— 边界退化成一个点，每个成员当场被夹到「框左上角减去自己宽高」的位置，一片节点全叠到框外面去。
  - **这道门必须开在「交给 Vue Flow 之前」，不能靠「晚一点再写文档」**。晚写只保得住打组的人自己：收到同步的那一方是直接从文档里读 `extent` 的，读到就立刻夹，而那时新的分组框在他那边还没渲染。**「打组没同步给别人」实际上就是这个** —— 数据完好地到了，是接收方的视图把它夹坏了。文档里的坐标自始至终是对的，所以刷新一下就好，也因此特别容易被当成同步问题。

#### 4.4.2 编辑器的拆分方式

**编辑器不是一个大组件**：`FlowEditor.vue` 只负责建上下文和摆组件，功能分在两层。

- **hooks 层（`src/composables/flow/`）** —— `provideFlowEditor(props)` 建一份共享 payload 并 `provide` 出去，子组件 `useFlowEditor()` 取用，**不逐层传 props**。里面是三个各管一摊的 composable：
  | composable | 管什么 |
  |---|---|
  | `useFlowDocument` | 加载元信息、改名、新建/复制/删除、同步状态文案、离开前 flush 视图状态 |
  | `useFlowCollab` | **这一条 WebSocket 连接**：房间 `flow:<flowId>`，交出 `doc`（给 store）和 `awareness`（给 presence） |
  | `useFlowCanvas` | Vue Flow 绑定：拖动 → `store.moveNodes`、连线 → `store.addEdge`、视口同步、Ctrl+滚轮缩放、新增节点、打组 |
  | `useFlowSelection` | 「现在轮到哪个节点」（Vue Flow 选中态的**投影**，恰好选中一个时才有值，决定节点工具栏露不露） |
  | `useFlowPresence` | 反馈层：上报光标/选中/拖动几何，读别人的 |
  | `useFlowSnapping` | 拖动时的网格 / 辅助线吸附（见 4.4.3），两者都常开、无开关、无持久化状态 |
  依赖是一条直线：`selection`/`collab` → `presence` → `canvas`，只有 `useFlowCanvas` 同时认识这三者。另有 `useFlowShortcuts(ctx)` 管快捷键和离开前的 flush。
- **组件层（`src/components/flow/`）** —— 一块界面一个组件，各自直接读上下文：`FlowCanvas`（画布本体，留了 `<slot/>` 给画布内浮层）、`FlowViewControls`（右上角控件 + 撤销/重做）、`FlowTitleCapsule`（左上角胶囊，自带删除确认）、`FlowToolbar`（底部工具栏）、`FlowSelectionToolbar`（框选一片时浮在选区上方的工具栏，目前放「打组」）、`ProcessNode` / `TextNode` / `GroupNode`（节点本体，只管自己长什么样）、`FlowNodeChrome`（每种节点共用的外壳：外部名字标签 + 单独选中时浮在正上方的工具栏，写一遍就够；按钮不一样的节点用 `#actions` 插槽换掉那一排，位置和露出时机仍由外壳说了算），`FlowSnapGuides`（拖动时的对齐辅助线），以及协同带来的三个：`FlowPresenceBar`（头像栏）、`FlowPresenceAvatar`、`FlowPresenceCursors`（别人的光标与正在拉的线）。

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
- **拖动的中间态故意不进文档**：只有 `onNodeDragStop` 的落点进 `mutate`，途中的位置走反馈层。否则一次拖拽就是几十次更新。
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
- [x] 列表接口的响应体里没有 `graph` 字段。（server/test/routes/flows.test.ts）
- [ ] 从画布列表点开一张画布，落到 `/flows/:id` 独立整页：**没有侧边栏**、没有项目主页的分区，画布占满视口；退回项目主页后侧边栏恢复。
- [ ] 左上角悬浮胶囊显示 logo + 画布名 + 菜单按钮；点 logo，项目画布回所属项目主页、个人画布回 `/personal`。
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
- [x] 节点 `data` 上平铺的任意业务字段，存取一字不差。（server/test/routes/flows.test.ts）
- [x] v1 的节点（`kind` + `config`）与连线在读出来时就地升级成 v2：`config` 拆平、空壳 `ports` 丢掉、`status` 补上，边的 `kind` / `condition` 保留。（server/test/collab/flow-doc.test.ts）
- [x] 两个人同时改同一个节点的不同业务字段，两边的改动都留下 —— 平铺之后才成立的合并粒度。（src/test/stores/flow.test.ts）
- [ ] 平移/缩放后刷新，视口回到离开时的位置；撤销按钮不会因为只挪了画布而变亮，撤销也拽不回视野。
- [x] **只平移不编辑时一个写请求都不发**；发生一次编辑后，攒着的视口立刻被顺路 PATCH 上去，之后的连续编辑合成一发在手停时补齐（一直不停手由 `maxWait` 顶上）。（src/test/stores/flow.test.ts）
- [ ] 同一张画布两个人各自平移到不同位置，互不影响；第三个人第一次打开时按投影里的兜底视口（或 fitView）。
- [x] 一张 `ydoc` 为空的老画布被打开后，旧 `graph` JSON 的内容原样出现在画布上，且此后以 Y.Doc 为准。（server/test/routes/flows.test.ts）
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
- 连线合法性校验（`dataType` 只存不判）。
- **把节点拖进（拖出）已有分组时自动归属**（reparent）：数据上 `parentNode` / `extent` 已经通了，分组也能由框选打组产生、能拉伸、能改名、删框留节点，缺的只是拖动时的命中判定。
- 自动布局、导入导出、导出图片。
- 跨画布、跨项目的节点复制粘贴；画布在项目间移动。

## 7. 待确认事项

暂无 —— 前几轮提出的问题已全部拍板并写进上文：撤销栈不跨会话、不存操作日志也不做历史、项目主页用同页 Tab、软删不清理不恢复、侧栏用「画布项目」替掉原来的「VueFlow」入口。

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
