# REQ-COLLAB Yjs 实时协同

> 状态：**已实现** —— 流程画布（REQ-CANVAS）的内容**就是**一个 Yjs 文档：
> 无冲突合并、只撤自己的、断线自动补发、服务端订阅同一条流落库。

## 1. 目标

在既有的单进程服务端上提供一个 Yjs 同步端点，验证：

- CRDT 协同能不能复用应用自己的登录态（而不是另起一套 token）；
- 不依赖官方 `@y/websocket-server` 包也能提供标准兼容的服务端；
- awareness 能不能直接拿来做「多人同时在一张画布上」的在场感知；
- 不用 y-leveldb（原生模块）也能把 Yjs 文档持久化到应用自己的库里。

## 2. 背景：服务端选型

用 **[Hocuspocus](https://tiptap.dev/docs/hocuspocus)**（`@hocuspocus/server`，MIT，node ≥ 22）。

在此之前这里是一份 y-websocket `bin/utils.js` 的移植（282 行）—— 之所以曾经自己写，
是因为上游 `@y/websocket-server` 静态 import `y-leveldb` → `leveldown`，
那是个原生模块，node 22 / arm64 上没有预编译产物，import 直接抛错。

换成 Hocuspocus 之后这个问题不存在（它不绑定任何存储），而且白得几样自己写要花功夫的东西：

| 能力 | 对应的 hook |
|---|---|
| 握手鉴权（我们用 cookie，不是 token） | `onConnect`（payload 带 `requestHeaders`） |
| 持久化 + **自带防抖**、散场与退出时保证落库 | `onLoadDocument` / `onStoreDocument` |
| 审计「谁改了什么」 | `onChange`（带 `update` 和 `context`） |
| 房间生命周期、心跳、重连 | 上游负责，我们不写 |
| 未来：消息拦截 / awareness 防伪 / 只读 / 多实例 | `beforeHandleMessage` / `beforeHandleAwareness` / `readOnly` / redis extension |

代价是**线协议和 y-websocket 不兼容**（Hocuspocus 每条消息以文档名开头，房间名走消息不走 URL），
所以前端必须用 `@hocuspocus/provider`。

### 2.1 和 Vite HMR 共存（实测过）

不调 `hocuspocus.listen()` —— 那会另起一个 WebSocket 服务、另占一个端口，而我们是单进程单端口。
走官方的「接管已有 server」路径：自己监听 `upgrade`，**只接管 `/ws`**，
其余（HMR 的 `vite-hmr`，路径 `/`）不碰 —— Node 的 `upgrade` 是多监听器事件，
我们不处理，Vite 自己那个监听器就会收到。crossws 的 node adapter 不自注册监听器，
`handleUpgrade` 只在被调用时才动手，所以「不管」是真的不管。

验证方式不是「HMR 的 socket 连上了」，而是**真改一个文件**：
`[vite] hot updated` 出现、页面内容变了、且 `performance` 里导航次数仍是 1（没有整页刷新）。

## 3. 功能需求

### 3.1 端点

- 地址：`ws://<host>:<port>/ws`，与 HTTP 服务同端口同源。
- 一个房间（= Hocuspocus 的 documentName）= 一个 `Y.Doc`。
  **房间名走消息，不走 URL** —— 由 `HocuspocusProvider` 的 `name` 传，画布房间是 `flow:<flowId>`。
- 只接管 `/ws` 的 upgrade，其余留给 Vite HMR（见 §2.1）。
- **房间生命周期由 Hocuspocus 管**：第一个人进来触发 `onLoadDocument`，
  改动后按防抖触发 `onStoreDocument`，最后一个人走后再存一次并卸载文档。

### 3.2 握手鉴权

- 握手是普通 HTTP 请求，同源会自动带上 `sid` Cookie。
- 用与 HTTP 相同的会话校验逻辑（`server/auth/ws.ts` 的 `authorizeCollab`），挂在 `onConnect` 上 ——
  它对**每条**连接都跑；`onAuthenticate` 是 token 模型（"only if required"），我们用 cookie，不走它。
  抛异常即拒绝；返回值成为 `context`，后面的 hook（审计的 actorId）都读它。
- **房间即资源**：房间名形如 `flow:<flowId>` 的，还要再判一次「请求者是不是该画布所属项目的成员」，
  规则与 `requireFlowMember` 一致（画布不存在、非成员一律拒绝，不区分两者）。
  其余房间（演示用）保持「登录即可」。
- 握手会像其它请求一样顺手给会话续期；此后每分钟的**复验**则不会（`{ refresh: false }`，见 4.2）。

### 3.3 与 Vite HMR 共存

- 开发环境下 Vite 的 HMR socket 也走同一个 `upgrade` 事件（协议 `vite-hmr`，路径 `/`）。
- 因此开发环境 `destroyUnmatchedUpgrades` 必须为 `false`，否则会把 HMR 连接杀掉。
- 生产环境为 `true`：不匹配 `/ws/*` 的 upgrade 一律销毁。

### 3.4 运行参数

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `YWS_PING_TIMEOUT` | 30s | 心跳超时，超时断开 |
| `YWS_GC` | 开启 | 设为 `false` / `0` 关闭 Yjs GC —— **使用快照功能时必须关闭** |
| `YWS_STATS_INTERVAL` | 30s | 统计日志间隔，`0` 关闭 |

### 3.5 监控端点

`GET /api/collab/rooms` 返回：

```jsonc
{
  "rooms": [{ "name": "…", "connections": 2, "awarenessClients": 2 }],
  "totalRooms": 1,
  "totalConnections": 2
}
```

### 3.6 前端接入约定

- 使用 `@hocuspocus/provider` 的 `HocuspocusProvider`（**不能用 y-websocket**，线协议不兼容）：
  `url` 传由当前 `location` 推导出的**绝对 ws:// / wss:// 地址**（路径 `/ws`，不要硬编码 host），
  `name` 传房间名。身份不走 `token` —— httpOnly 的 sid cookie 在握手时自动带上。
- **`vite.config.ts` 必须 `resolve.dedupe: ['yjs', 'y-protocols']`**。
  我们和 provider 各自 `import * as Y from 'yjs'`，Vite 预打包会把 yjs 复制一份进 provider 的产物，
  于是浏览器里有两个副本（控制台喊 "Yjs was already imported"）。这不只是告警：
  两份副本之间 `instanceof` **永远为 false**，而 `src/lib/flow-doc.ts` 通篇靠
  `value instanceof Y.Map` 判断结构 —— 静默失效的话画布会变成一张空图。
- 画布房间（`flow:*`）已持久化到应用自己的库；其余房间仍是纯内存的，重启即丢。

### 3.7 持久化（`server/collab/persistence.ts`）

**不用 y-leveldb**（原生模块），也**不用 `@hocuspocus/extension-database`` ——
后者只是 `onLoadDocument` / `onStoreDocument` 的一层薄封装，直接实现这两个 hook 更直白。
写的是现成的 Prisma 表，一个原生依赖都不需要（SQLite / PostgreSQL 都行）。

**落库的时机不归我们管了**，Hocuspocus 自带：

| 时机 | 做什么 |
|---|---|
| 建房（`onLoadDocument`） | 读 `Flow.ydoc`。为空则从老的 `graph` JSON 现场构建 |
| 改动后 2s（`debounce`），持续编辑最长 10s（`maxDebounce`） | 只写 `ydoc`；**状态向量和上次一样就整个跳过** |
| 卸载前（`beforeUnloadDocument`） | 写 `ydoc` + **派生投影**（`graph` / 计数） |
| 进程退出 | `closeConnections()` + 逐房间直接落库（`flushAllRoomsToDatabase`）+ 等写队列排空 |
| 每条客户端更新（`onChange`） | 追加一行 `FlowOperation`（Yjs 增量 + actorId + serverTs） |

**为什么投影要挂在 `beforeUnloadDocument` 而不是 `onStoreDocument` 的 `clientsCount === 0`**：
最后一个人离开时，Hocuspocus 只在「还挂着防抖 store」的情况下才补一次 `onStoreDocument`，
否则直接卸载文档。也就是说「改完等两秒再关页面」这条最常见的路径根本不会再触发它 ——
实测确认过，散场时一次都没调。`beforeUnloadDocument` 在文档销毁前触发，那时内容还读得到。

**老数据的迁移就是 `onLoadDocument` 那一步**：`ydoc` 为 NULL 的画布在第一次被打开时，
把 `graph` JSON 灌进 Y.Doc。不需要单独的迁移脚本，也不需要停机 ——
每张画布各自在被打开时完成，没打开过的原样躺着。

### 3.8 本地缓存（`y-indexeddb`）

同一个 `Y.Doc` 上还挂了一份 IndexedDB 缓存，库名就是房间名。它带来两件事：

- **打开画布先从本地渲染**，不用等网络；
- **断网时改的东西不随关页面丢掉** —— 重连后本地那些改动自动补发，CRDT 负责合并。

因此加载态的判据是「服务端已同步 **或** 本地缓存里有内容」。
「缓存加载完了但里面是空的」不算就绪 —— 那既可能是画布本来就空，也可能是我从没打开过它而此刻断着网，
这时候继续显示加载中，比甩一张空画布让人以为内容丢了要好。

**离线提示不能只看 provider 的状态**：拔网线后它要等心跳超时（几十秒）才察觉，
这期间界面会一直显示「已同步」，而用户改的东西其实只落在本地。所以叠加了 `navigator.onLine`
（反应即时，但网卡通不代表连得上服务器），**两者都为真**才算连着。

销毁顺序也有讲究：先断网络、再摘本地缓存、最后销毁文档 —— 反过来的话缓存那边还挂着已销毁文档的监听。
只 `destroy()` 不 `clearData()`，缓存留着下次还能离线用。

## 4. 流程画布的协同（已实现）

第一个落地场景是流程画布（REQ-CANVAS，`/flows/:flowId`），一张画布一个房间：`flow:<flowId>`。
连接层在 `src/composables/flow/useFlowCollab.ts`，一条 WebSocket 上驮两件互不相干的事。

### 4.0 行为规范：数据层 vs 反馈层

协同的一切行为都落在这两层之一。**判断一个新东西该放哪层，只问一句：刷新页面之后它还该在吗？**

| | **数据层** | **反馈层** |
|---|---|---|
| 实现 | `stores/flow` + `src/lib/flow-doc.ts` | `useFlowPresence` + `src/lib/presence.ts` |
| 走什么 | Yjs 共享类型（`Y.Map`） | Yjs awareness |
| 内容 | 节点、连线、图元数据 | 光标、选中、拖动中几何、正在拉的线 |
| 生命周期 | 持久，可撤销 | 易失，断线即消失，**绝不落库** |
| 丢一帧会怎样 | 不会丢：Yjs 的更新可交换、可结合、幂等，重连自动补 | 无所谓，下一帧覆盖 |
| 刷新后还在吗 | 在 | 不在 |
| 扩展方式 | 在 `flow-doc.ts` 的结构里加字段 | 加一个 awareness 字段 + 一个 computed |

**画布内容就是那个 Y.Doc**，不再有「快照 + 提交 + 乐观锁」那一套：

```
ydoc
 ├─ nodes: Y.Map<nodeId, Y.Map>   节点；其中 data 又是一层 Y.Map
 ├─ edges: Y.Map<edgeId, Y.Map>   连线
 └─ meta:  Y.Map                  画布级自定义数据 + 兜底视口
```

**为什么节点是 Y.Map 而不是整块 JSON**：Y.Map 的合并粒度是 key。甲改标题、乙同时拖位置，
两人改的是不同的 key，CRDT 会各自保留；存成一整块 JSON 的话后到的那份会把先到的整个盖掉。
`data` 再套一层同理 —— 属性面板上 label / description / config 是分开改的。

服务端的 `Flow.graph` JSON 降级成**只读投影**：列表页的节点数、缩略图、将来的只读预览读它，
编辑器不读（编辑器的内容直接来自 Y.Doc）。它由服务端在写状态时派生，客户端再也不提交它。

⚠️ Y.Doc 的结构在前后端各写了一份（`src/lib/flow-doc.ts` / `server/collab/flow-doc.ts`）——
两个 TS 工程互相 import 不了。**键名和嵌套结构必须完全一致**，改一处记得改另一处。

**依赖方向是一条直线，不成环**（`composables/flow/context.ts`）：

```
selection ──┐
collab ──┬──┴─→ canvas      canvas 是唯一同时认识三者的接合层
         └─→ presence ──┘
```

`collab` 连上后把 Y.Doc 交给 store（`store.attachDoc`），内容从那一刻起就是它。
`presence` 不认识 selection、也不认识 Vue Flow —— 它只提供「上报」和「读别人」两组能力。
本地状态怎么接进去、别人的占用怎么落到画布上，全在 `useFlowCanvas`。
所以加一种新的反馈信号（正在输入标题、框选范围…）只需要动 `presence` 加一对 set/computed，
不用碰选中态和画布。

#### 数据层的规则

- **所有内容变更都走 `store.mutate()`**。它把改动包进一个带 `LOCAL_ORIGIN` 的 Y 事务 ——
  只有这样改动才会被 `Y.UndoManager` 认领、才会同步给别人、才会被服务端落库。
  组件不许直接碰 Y.Map。
- **撤销只撤自己的**：`Y.UndoManager` 的 `trackedOrigins` 只收 `LOCAL_ORIGIN`，
  别人同步过来的改动根本不进我的撤销栈。这是 Yjs 自带的能力，不需要自己实现历史。
- **没有保存、没有 revision、没有 409。** 改动即刻同步，服务端订阅同一条流落库。
  CRDT 天然收敛，不需要乐观锁，也就没有冲突态可言。
- **拖动的中间态不进 Y.Doc**：一次拖动会派发几十次位置变化，全写进去等于几十条更新 +
  几十条审计。中间态给别人看走反馈层，落定的位置在 `onNodeDragStop` 一次性提交。
- **Vue Flow 的默认行为会绕过 store**（`applyDefault: true` 下的 `deleteKeyCode` 就是：
  它直接改自己内部的 nodes/edges），必须关掉后自己接管，否则本地看着生效了，
  实际不进撤销栈、不落库、也不同步。

#### 反馈层的 awareness 字段

| 字段 | 内容 |
|---|---|
| `user` | `{ id, name, avatarUrl, color }`，颜色由 id 哈希到固定配色表 |
| `cursor` | 鼠标位置，**画布坐标**（不是屏幕坐标，各人视口不同） |
| `selection` | 选中的元素 key 列表 |
| `transform` | 正在直接操作的元素 → 实时几何（目前是拖动中的位置） |
| `connecting` | 正在拉线的起点；终点跟着 `cursor` 走，不重复发 |

### 4.0.1 占用规范（**已实现，当前未启用**）

> 状态：仲裁逻辑和测试都在（`src/lib/presence.ts`、`src/test/lib/presence.test.ts`），
> 但**画布上没有接这条线** —— 谁都可以同时改同一样东西，由 CRDT 负责合并。
> 要恢复限制，在 `useFlowCanvas` 把 `presence.lockedKeys` 重新接到节点/边的
> `draggable` / `selectable` / `updatable` 上即可。
>
> 摘掉的原因：CRDT 已经保证不会丢改动，占用是**产品选择**而不是正确性需要 ——
> 先让协作跑顺，需要时再按下面的规范加回来。

原则：**一个元素正在被某个人编辑时，别人不能同时改它。**
判一件事要不要挡，就问：**这个操作会改到那个元素本身吗？**
会 → 挡；不会（哪怕操作在它身上发生）→ 放行。

- **元素 = 节点或边**，统一标识 `node:<id>` / `edge:<id>`（`elementKey`）。
- **直接占用**（`occupies()`）：选中了它 / 正拖着它 / 正从它拉线（还没松手）。
- **派生占用**：占住一个节点 = 占住连到它的所有边（断开一条接在它上面的线，
  改的就是这个节点的连接关系）。这条要在画布层算 —— `lib/presence.ts` 不认识图。
- **仲裁：clientId 最小者胜。** 各端拿同一份状态算出的赢家一致，不需要服务端参与。
- **放行**：从被占用的节点拉出新连线、把线连到它上面 —— 动的是新的边，节点本身没变。

**只读标记如果要写，必须每次都显式写 `true` / `false`**，不能「锁了才写」。
Vue Flow 同步节点用的是 `Object.assign(内部那份, 传进来的这份)`，是就地合并：
某一次不带 `selectable` 这个键，上次写的 `false` 就永远留在它内部那份节点上。

### 4.0.2 拖动期间不能重建节点数组

**这是个反复踩到的坑，单独记一条。**

Vue Flow 靠 `:nodes` 的**数组引用**判断要不要重新同步节点。一旦重新同步，它会用
`Object.assign(内部那份, 传进来的这份)` 把手上正在拖的位置覆盖成传进去的那份 ——
而拖动的中间态**不写进 Y.Doc**（一次拖动会派发几十次位置变化），
所以传进去的是拖动**前**的位置：节点当场弹回原地。

偏偏拖动期间一定有东西在变：本地正往 awareness 上报拖动位置，
这会触发本地的 awareness change，`presence` 的派生值跟着重算。

所以 `useFlowCanvas` 里有一个 `localDragging` 开关：自己拖动期间，
`nodes` 直接返回 `store.nodes` 原数组，不做任何 map。

### 4.1 功能需求

- **在场头像栏** —— 标题胶囊右侧一枚同高（`h-10`）的胶囊，头像堆叠展示，最多 5 个、多余收成 `+N`；
  靠左的压在靠右的上面，「我」永远排第一。左侧一颗圆点表示连接状态。
- **他人光标** —— 画布上画出箭头 + 头像 + 用户名，颜色即该用户的身份色。
  鼠标移出画布就收起来，不在别人屏幕上留一个不动的箭头。
- **「谁在动它」标识** —— 有人选中 / 拖动 / 从它拉线时，节点名称边上贴上那个人的头像 + 名字。
  **只是提示，不是限制**（见 §4.0.1）。
- **就地改标题** —— 双击节点标题变输入框，回车提交、Esc 取消、失焦即提交。
  进编辑态会先选中该节点，一来属性面板跟着走，二来别人能看到「有人在动它」。
  提交走 `store.updateNodeData`，因此能撤销、会同步、会落库。
- **内容实时跟随** —— 一方新增 / 移动 / 删除节点、连线、改属性、撤销重做，
  另一方**不刷新**就能看到（见 §4.0）。
- **拖动过程实时反馈** —— 拖动中的位置逐帧走反馈层，别人看到的是节点跟着手走，
  不是松手瞬间瞬移。松手时**先**发落定的操作、**再**收临时几何，
  反过来的话对方会先退回旧坐标再跳一下，看着就是闪一下。
- **连线过程实时反馈** —— 一方从连接口拉线时，别人看到一条同色虚线从那个连接口连到他的光标。
  路径用 Vue Flow 自己的 `getBezierPath` 算，形状和本地拉线时看到的一致。

### 4.2 数据可信度：三道防线

内容不再经过任何 REST 接口，所以校验也全部移到了协同这条链路上。

**① 身份由服务端说了算（`beforeHandleAwareness`）**

awareness 的内容本来完全由客户端自己写、服务端只转发 —— 同房间的人可以把自己的 `user`
改成别人的名字和头像。现在服务端在转发前把 `user` 覆盖成 `onConnect` 认定的那一份
（`server/collab/awareness.ts` 的 `enforceIdentity`）。

只覆盖身份三件套（`id` / `name` / `avatarUrl`），**不动** `cursor` / `selection` / `transform` ——
那些不是身份，报错了也只是画面不准，而且每帧都在变。

覆盖身份还不够：awareness 更新按条目自带的 `clientID` + clock 应用，冒用队友 `clientID`、
把 clock 抬高，就能覆写对方的光标和拖拽几何，对方自己的真实更新反而因 clock 偏低被忽略。
所以还有一道**归属登记**（`dropForeignClients`）：谁的 socket 先发布一个 `clientID`，
这个号就归谁；别的连接发来的同号条目整条丢弃。断线释放（`onDisconnect`）、散场作废。

**连接活着 ≠ 权限一直在**：`onConnect` 只在握手跑一次，被移出项目 / 会话已灭的人若靠
一条不断的 WebSocket 留在房间里，读写权就永远收不回。服务端每分钟对在线连接**复验**
一遍会话 + 成员身份（`revalidateConnections`），查不过的踢下线；踢掉后 provider 的
自动重连会在握手处被同一套检查拒绝。只有确凿的拒绝才踢 —— 数据库 / Keycloak 连不上
证明不了任何事，连接留着下轮再查（和会话刷新对网络故障的态度一致）。

**复验只看，不续期**（`authorizeCollab(..., { refresh: false })`）。会话的空闲超时握在
Keycloak 的 refresh token 手里，而每续一次就把它往后推一次 —— 复验每分钟跑一趟的话，
挂着一个画布标签页不动的人就**永远不会空闲超时**，长连接自己给自己续了命。
所以只读复验只回答「此刻还有效吗」（refresh token 还在就算有效），续期留给真实的
HTTP 请求：握手本身算一次，此后由编辑触发的视图状态 PATCH 顶上（`noteLocalEdit()`，
见 [REQ-CANVAS](13-flow-canvas-management.md) 4.6）。净效果是**在编辑就续着、
只挂着不动就该超时超时**；refresh token 也过期之后，下一轮复验就把连接踢下线。

> 验证时注意：`awareness.getStates()` 里**自己那条是本地状态，根本不过服务端**。
> 要验证防伪，必须从**另一条连接**读。

前端仍然当不可信输入解析（形状不对的整条丢弃），颜色也在本地按 id 重算 —— 多一层不吃亏。

**② 内容配额（`beforeHandleMessage` 拦、`onChange` 量）**

| 项 | 软限 | 硬限（软限 × 1.25） |
|---|---|---|
| 单条消息 | 1 MB（超了只拒这一条） | — |
| 文档状态 | 2 MB | 2.5 MB |
| 节点数 | 2000 | 2500 |
| 连线数 | 4000 | 5000 |

软限的数字直接从 `GRAPH_LIMITS` 派生（`server/store/flow-types.ts`），不另抄一份 ——
两套上限一旦漂移，「协同这边合法、投影那边超限」的文档会在列表 / 复制那条路上读成空图
（落库侧还有一道兜底：投影 JSON 超过 `GRAPH_LIMITS.bytes` 就跳过本次投影写入，留上一份）。

**拒绝永远不 `throw`** —— Hocuspocus 对被 throw 的消息直接关连接，而 provider 会自动重连
再发同一条：超限房间就此对所有人不可达，攒了大改动的离线客户端陷入永久重连死循环。
拒绝一律走 `readOnly`：Hocuspocus 对只读连接的写入回 NACK，不应用、不断连，读和 awareness 照常。

**为什么分两级**：超限后唯一的自救路径是删东西，而删除也是写入 —— 软限一超就拒写的话，
房间就永远卡在超限那一刻。所以软限只标记（写入照常，删回去自动解除），
硬限才锁写（锁到散场重开），软硬之间的余量就是留给「删回去」的操作空间。

**只能事前挡，不能事后回滚** —— Yjs 的更新一旦应用并广播就收不回来了。
节点 / 连线数是 `Y.Map.size`（O(1)）每次都查；字节数要序列化整个文档，按两个条件节流：
距上次超过间隔（5s，已超软限时缩到 1s），或这期间收进的更新已攒够 128 KB ——
后者堵住「窗口内高频塞大消息」这条路，超量最多超出一个触发阈值。

**③ 悬空边清理（`onStoreDocument`）**

甲删掉一个节点、乙同时往它连线 —— 两个操作各自合法，CRDT 把它们都保留，
于是留下一条指向空处的边。投影层会把它过滤掉所以界面上看不见，但它一直躺在文档里、只会越积越多。
落库前清一次（`pruneDanglingEdges`），用 `'gc'` 这个 origin —— 客户端的 `UndoManager`
只跟踪自己的 `LOCAL_ORIGIN`，所以清理不会跑进任何人的撤销栈。

## 5. 已知缺口

- **同一个字段的并发写仍是「只有一个赢」**：CRDT 保证所有人最终看到同一个结果，
  但赢家是按 Yjs 的内部规则定的，从用户角度不可预测。占用（§4.0.1）就是为这个补的 ——
  它把「两个人同时改同一样东西」这件事在交互层挡掉。**不同字段并发改是真合并**，不冲突。
- **多实例**：房间的 Y.Doc 在单个进程的内存里，所以部署仍必须 `replicas: 1`。
  要横向扩展得换 [`@y/hub`](https://github.com/yjs/yhub) 那种经 redis 流转的后端。
- **最多丢一个防抖窗口**：全量状态按 2s / 10s 上限防抖写，进程被 `kill -9` 会丢掉窗口内的改动
  （正常退出有 SIGTERM 兜底：`closeConnections` 后逐房间直接落库再等写队列排空 ——
  不走 `flushPendingStores`，它触发的落库要过一段微任务链才入队，同步采样会扑空）。
  审计日志是每次更新即写的，不受影响。
- **断网时刷新打不开页面**：数据有 IndexedDB 兜底，但应用本体要从服务器加载。
  要做到「断网刷新照样用」得再加 Service Worker，那是另一件事。
- 富文本编辑器（REQ-PROMPT）尚未接入。

## 6. 验收标准

- [x] 两个浏览器连同一张画布，头像栏能互相看见对方，一方关闭页面后头像随即消失。
- [x] 一方移动鼠标，另一方能看到带头像和名字的光标；移出画布后光标消失。
- [x] 一方选中 / 拖动节点，另一方在节点名边上看到那个人的头像 + 名字（提示，不拦操作）。
- [x] **占用限制已摘掉**：一方选中节点后，另一方仍能拖它、删它。
- [x] **拖动不回弹**：拖完停在放手的位置，等待若干秒后也不会被拽回，可以连续拖。
- [x] 双击节点标题能改名，另一方同步看到。
- [x] 一方新增 / 拖动节点，另一方不刷新就能看到，且双向都成立。
- [x] **拖动过程中**（还没松手）另一方就能看到节点在动，并已看到它被占用。
- [x] **拉线过程中**另一方看到一条同色虚线从起点连到拉线者的光标；松手即收线。
- [x] 删除连线会同步给对方，并且刷新后确实没了（不再被 Vue Flow 的默认删除键绕过 store）。
- [x] 两人协同编辑后刷新，内容与屏幕上一致。
- [x] **两人同时改同一个节点的不同字段，两边的改动都留下**（CRDT 字段级合并）。
- [x] **撤销只撤自己的**：我按 Ctrl+Z 撤掉的是我加的节点，同伴加的那个还在。
- [x] 所有人离开后房间被销毁（`/api/collab/rooms` 归零），内容已落进 `Flow.ydoc`。
- [x] 重新打开画布，内容从 `ydoc` 恢复。
- [x] 老画布（只有 `graph` JSON、没有 `ydoc`）第一次打开时自动迁移，内容不丢。
- [x] 操作日志记下了每次更新的 `actorId`（服务端认定，客户端伪造不了）。
- [x] **一方伪造 awareness 身份，另一方看到的仍是服务端认定的真身**；同时光标位置原样保留。
- [x] 节点 / 连线数超限后，房间被标记为拒绝写入；散场后重新判定。
- [x] 并发「删节点 + 连线」留下的悬空边在落库前被清掉，且不进任何人的撤销栈。
- [ ] 未登录直接连 `/ws/test` 收到 401 并断开。
- [x] 非项目成员连 `flow:<id>` 被拒绝（`server/test/auth/ws.test.ts`）。
- [ ] 开发环境下协同连接和 Vite HMR 同时工作，互不影响。
- [ ] 断网 / 挂起超过心跳超时后连接被回收，`/api/collab/rooms` 中的计数随之下降。
- [ ] 客户端断线重连后能恢复到最新文档状态（前提是服务端未重启）。

## 7. 本期不做

- **多实例**：跨进程的房间同步。要做就换 [`@y/hub`](https://github.com/yjs/yhub)（yjs 官方组织，
  updates 经 redis 流转、可持久化到 Postgres / S3），而不是自己再造一层广播。
- **离线编辑**：接 `y-indexeddb` 就能让改动跨刷新存活、重连自动补发。协议这边已经支持，
  只差前端挂一个 provider。
- 历史版本 / 时间机器。`FlowOperation` 里已经是可回放的增量序列，材料齐了，缺的是界面。
- 服务端改写 awareness 中的用户身份（杜绝同房间内的冒名）。
- 富文本编辑器（REQ-PROMPT）接入 Yjs。

## 8. 待确认事项

- `FlowOperation` 的保留策略：现在只追加不清理，一张活跃画布会一直长。
  按条数 / 天数裁剪，还是定期合并成一个「基线 + 增量」？
- 要不要给 `Y.Doc` 关掉 GC（`YWS_GC=false`）以支持历史版本回溯 —— 代价是文档体积一直涨。
