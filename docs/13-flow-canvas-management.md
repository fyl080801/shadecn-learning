# REQ-CANVAS 项目、画布管理与操作历史

> 状态：**已实现** —— 后端（5 张表 + 三组路由 + 权限中间件）、Pinia store、四个页面均已落地，测试覆盖见第 5 节。
>
> 前置：[REQ-FLOW](09-flow-chart.md) 已经验证了 Vue Flow 的交互定制（滚轮手感、自定义节点、连线）。本需求接着往上叠**项目 + 多画布 + 持久化 + 操作历史**，`/vue-flow` 那个单页 demo 变成「打开某一张画布」的编辑器形态。

## 1. 目标

1. 引入**项目**作为画布的上一层容器：项目管成员，成员身份决定画布的访问权。
2. 加入项目的**唯一方式是邀请链接**，由项目管理员生成；创建者即管理员。
3. 一个项目里能存在**多张画布**，由数据库维护；列表分页展示，可新建 / 重命名 / 复制 / 删除 / 打开。
4. 画布内容在前端由 **Pinia** 持有，所有变更走**操作（operation）**通道，从而天然支持**撤销 / 重做**。
5. 产生的操作**同时写库**：既留下审计/回放的可能，也让「刷新页面内容不丢」成立。
6. 数据结构从第一天起就为扩展留口子：节点除了 Vue Flow 的布局字段外，还有一块**自定义业务数据**；数据库统一按 **JSON 字符串**存，加字段不用迁移。

## 2. 名词

| 名词 | 含义 |
|---|---|
| 项目 / Project | 画布的容器与权限边界，成员的集合 |
| 成员 / Member | 项目内的一个用户，角色为管理员或普通成员 |
| 邀请链接 / Invite | 一个带随机 token 的链接，是加入项目的唯一入口 |
| 画布 / Flow | 一张图，列表里的一行，编辑器里的一个文档 |
| 图内容 / Graph | 画布的全量内容：`nodes` + `edges` + `viewport` |
| 操作 / Operation | 一次可撤销的最小语义变更，例如「新增节点」「移动节点」 |
| 事务 / Transaction | 一组被合并成「一次撤销」的操作，例如框选后一起拖动 N 个节点 |
| 修订号 / revision | 画布的单调递增版本号，每提交一个事务 +1，用于乐观锁 |

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

- **admin** —— 创建者自动获得。能改项目名/描述、生成与撤销邀请链接、移除成员、删除项目，以及 member 的全部能力。
- **member** —— 能看项目、看成员列表、对项目内画布做全部增删改。

### 3.3 邀请链接（`ProjectInvite`）

```ts
interface ProjectInvite {
  id: string
  projectId: string
  /** 32 字节随机数的 URL-safe base64，链接形如 /invite/<token> */
  token: string
  /** 接受后获得的角色，本期恒为 'member' */
  role: 'member'
  createdById: string
  createdAt: string
  expiresAt: string             // 默认创建后 7 天
  maxUses: number | null        // null = 不限次数
  usedCount: number
  revokedAt: string | null      // 手动撤销
}
```

**未登录用户点开邀请链接是可用的**：`/invite/<token>` 是普通页面路径，会被 `server/frontend/guard.ts` 拦下并 302 到 `/login?redirect=/invite/<token>`，登录完自动跳回，落在「确认加入」界面上。这条路径不需要额外开白名单。

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
  nodeCount: number             // 冗余统计，列表直接展示，提交时一并更新
  edgeCount: number
  revision: number              // 当前修订号
  createdById: string           // 创建者，仅用于展示，不用于鉴权
  createdAt: string
  updatedAt: string
}
```

> 注意：画布的访问权来自**项目成员身份**，不是 `createdById`。同项目内成员之间平权，谁建的都能改。

### 3.5 画布详情（`FlowDetail`）

```ts
interface FlowDetail extends FlowSummary {
  graph: FlowGraph
}
```

### 3.6 图内容（`FlowGraph`）—— 落库时序列化成一个 JSON 字符串

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
  type?: string                 // 默认 'smoothstep'
  animated?: boolean
  label?: string
  data: {
    kind?: string
    condition?: unknown         // 预留：分支条件
    config: Record<string, unknown>
  }
}
```

### 3.9 操作（`FlowOperation`）

一条操作必须**自带逆操作所需的信息**（`before` / `after`），否则撤销要重放全量历史。

```ts
type FlowOpType =
  | 'node.add' | 'node.remove' | 'node.move' | 'node.resize' | 'node.update'
  | 'edge.add' | 'edge.remove' | 'edge.update'
  | 'graph.meta'

interface FlowOp<T extends FlowOpType = FlowOpType> {
  type: T
  targetId: string                      // 节点或边的 id
  before: unknown | null                // 变更前的片段；add 为 null
  after: unknown | null                 // 变更后的片段；remove 为 null
}

/** 一次撤销的粒度 */
interface FlowTransaction {
  id: string                            // 客户端生成，用于幂等提交
  label: string                         // 展示给用户的描述，如「移动 3 个节点」
  kind: 'do' | 'undo' | 'redo'
  ts: number                            // 客户端产生这次事务的时刻，UTC epoch 毫秒
  ops: FlowOp[]
}
```

- **时间一律是 UTC epoch 毫秒的整数**，不用 ISO 字符串、更不用本地时间。协同要把多个客户端的操作排到同一条时间轴上，数值可以直接比大小，不受时区、格式、序列化精度影响。展示层才本地化（前端统一走 `src/lib/format.ts`，跟随浏览器）。
- 客户端的钟不可信，所以服务端另盖一个 `serverTs`：**排序以 `serverTs` 为准**，`clientTs` 只作为客户端自述的产生时刻保留。
- 客户端生成的 id（事务 / 节点 / 连线）统一走 `src/lib/id.ts` 的 `createId(prefix)`，形如 `<前缀>_<时间戳 base36>_<随机段>`。随机段不能省：两个客户端可能在同一毫秒各加一个节点，只靠时间戳会撞出同一个 id。

- `viewport` 的变化**不是操作**：它不进历史栈，也不产生操作记录，只在退出/定时保存时随快照写回。
- `node.move` 支持**合并**：同一节点连续拖动在拖拽结束前合并成一条（`before` 取拖拽开始时的位置）。

### 3.10 数据库模型（Prisma，新增四张表）

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

/// 邀请链接。token 明文存储 —— 它本身就是要发给别人的凭据，
/// 且失效靠 expiresAt / revokedAt / maxUses 三道闸，不靠不可读。
model ProjectInvite {
  id          String    @id @default(cuid())
  projectId   String
  token       String    @unique
  role        String    @default("member")
  createdById String
  createdAt   DateTime  @default(now())
  expiresAt   DateTime
  maxUses     Int?
  usedCount   Int       @default(0)
  revokedAt   DateTime?

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId, revokedAt])
}

/// 一张画布。graph 是全量快照，操作日志在 FlowOperation 里。
model Flow {
  id          String    @id @default(cuid())
  projectId   String
  name        String
  description String?
  status      String    @default("draft")   // draft | published | archived
  /// 标签，JSON 字符串数组（SQLite 无数组类型）
  tags        String    @default("[]")
  thumbnail   String?
  /// FlowGraph 的 JSON 字符串
  graph       String    @default("{}")
  nodeCount   Int       @default(0)
  edgeCount   Int       @default(0)
  /// 修订号，每提交一个事务 +1；客户端提交时带 baseRevision 做乐观锁
  revision    Int       @default(0)
  createdById String
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  /// 软删除：列表默认过滤掉非 null 的行
  deletedAt   DateTime?

  project    Project         @relation(fields: [projectId], references: [id], onDelete: Cascade)
  operations FlowOperation[]

  @@index([projectId, deletedAt, updatedAt])
}

/// 操作日志，只追加、不修改、不删除（删画布时级联）。
model FlowOperation {
  id        String   @id @default(cuid())
  flowId    String
  /// 画布内自增序号，从 1 开始，提交后与 Flow.revision 对齐
  seq       Int
  /// 客户端事务 id，用于重试幂等
  txId      String
  /// do | undo | redo —— 撤销也是一条新记录，日志永远只往前走
  kind      String   @default("do")
  label     String
  /// FlowOp[] 的 JSON 字符串
  ops       String
  actorId   String?
  /// 客户端产生这次事务的时刻（UTC epoch ms）
  clientTs  BigInt
  /// 服务端落库时刻（UTC epoch ms）—— 客户端的钟不可信，排序以它为准
  serverTs  BigInt

  flow Flow @relation(fields: [flowId], references: [id], onDelete: Cascade)

  @@unique([flowId, seq])
  @@unique([flowId, txId])
  @@index([flowId, seq])
}
```

`User` 上要补两条反向关系：`memberships ProjectMember[]` 与 `createdProjects Project[] @relation("ProjectCreator")`。

**为什么快照 + 日志双写**：只有日志则打开画布要重放全部历史；只有快照则撤销无从谈起、也没有审计。二者都写，读走快照（O(1)），日志作为可回放的旁路。

## 4. 功能需求

### 4.1 项目列表页（`/projects`）

- 应用的落地页，卡片或表格形态都行，展示：项目名、描述、成员数、画布数、我的角色、更新时间。
- 分页：默认每页 20；页码写进 URL query。
- 只列出**我是成员**的项目 —— 没有「所有项目」视图，也没有公开项目。
- 顶部「新建项目」：填名称后创建，创建者自动成为该项目的 admin 成员（`ProjectMember` 里要真实写入这一行，不能靠 `createdById` 隐式推断，否则成员列表和权限判断得处处特判）。
- 空态要给出引导：「你还没有项目 —— 新建一个，或让同事把邀请链接发给你」。

### 4.2 项目主页（`/projects/:id`）—— 一个界面统一展现

**不做多页面**。进入项目后就一个界面：固定的项目头部 + 下方**同页 Tab**（`画布` / `成员`）。**Tab 切换不改变路由**，也不触发页面级 loading —— 两个 Tab 的数据在进入项目时就各自请求好，切换只是显隐。

**项目头部**（常驻，不随 Tab 切换）
- 项目名与描述；admin 可就地编辑。
- 右侧操作：`邀请成员`（仅 admin）、`删除项目`（仅 admin，二次确认，软删）。

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
- admin 额外看到：每行的「移除」按钮（不能移除自己）、以及项目头部的邀请入口。
- 邀请面板（admin 打开的对话框，不是新页面）：`生成邀请链接` → 展示完整 URL + 一键复制 + 过期时间；下方列出该项目当前**有效**的邀请，每条可「撤销」。
- 生成时可选有效期（1 天 / 7 天 / 30 天，默认 7 天）与使用次数上限（不限 / 1 次 / 10 次，默认不限）。

### 4.3 邀请与加入（`/invite/:token`）

- 页面先调 `GET /api/invites/:token` 预览：显示「你被邀请加入 **XXX 项目**（N 位成员）」+ `加入` / `取消` 两个按钮。**不做点开即加入** —— 用户得看清楚自己要进哪儿。
- 未登录时由页面网关 302 到登录，登录后自动跳回本页（见 3.3）。
- 点「加入」→ `POST /api/invites/:token/accept` → 成功后跳到 `/projects/:id`。
- 各种失效状态给出明确文案，不要一律「链接无效」：已过期、已被撤销、使用次数已满、项目已删除。
- **已经是成员**时：预览接口直接告知，按钮变成「进入项目」，点了直接跳转（accept 接口本身也幂等，重复调用不报错、不涨 `usedCount`）。

### 4.4 画布编辑器（`/flows/:id`）—— 独立整页

**从画布列表点进来是跳到一个独立页面，不套项目主页那层带菜单的外壳。** 编辑器要整块屏幕，侧边栏和项目主页的分区在这里都是干扰。

这对应用外壳（[REQ-SHELL](01-app-shell.md)）是个改动：`App.vue` 当前无条件渲染 `AppSidebar`，「每个 SPA 路由都带菜单」这条约束到此为止。做法是路由 `meta` 上加一个布局标记（如 `meta: { layout: 'bare' }`），`App.vue` 据此决定渲不渲染 `AppSidebar`；`/flows/:id` 是第一个 bare 路由。注意这**不是**登录态的例外 —— 它依然是登录后才能进的页面，只是不带菜单。

> 改的只是 `App.vue` 里「渲不渲染」这一个判断，`AppSidebar.vue` 的布局与行为都不动 —— 只是把导航项里的「VueFlow」换成指向 `/projects` 的「画布项目」（`/vue-flow` 那个 demo 路由本身保留，只是不再挂在菜单上）。

- 进入时 `GET /api/flows/:id` 取全量，灌进 Pinia store，按 `graph.viewport` 恢复视口。
- 沿用 [REQ-FLOW](09-flow-chart.md) 的全部交互（滚轮平移、Ctrl+滚轮以光标为锚点缩放、自定义节点、连线）。
#### 4.4.1 悬浮胶囊工具条（左上角）

页面没有应用菜单，编辑器自己的入口收在**左上角一枚悬浮胶囊**里，浮在画布之上（圆角、半透明背景 + 模糊、与画布内容有明显层次）。从左到右三段：

1. **Logo（home）** —— 点击**返回该画布所属的项目主页**（`/projects/:projectId`）。它是这个页面唯一的「回去」入口，所以必须一眼可辨。
2. **画布名** —— 就地编辑；新建未命名时显示占位「无标题」。名字右侧跟一个克制的保存状态指示（`已保存` / `保存中…` / `未保存` / `保存失败，点击重试`），不抢视线。
3. **菜单按钮** —— 点开下拉：

   | 菜单项 | 行为 |
   |---|---|
   | 新建画布 | 在**同一项目**下新建并直接跳过去；当前画布有未提交事务时先 flush |
   | 复制 | 调 `duplicate`，成功后跳到副本 |
   | 删除 | 二次确认后软删，然后回到项目主页 |
   | 返回画布首页 | 回到 `/projects/:projectId`，与点 logo 等价（给一个带文字的显式出口） |

- 缩放 / 适应视图 / 锁定的控件组挪到**右上角**（[REQ-FLOW](09-flow-chart.md) 里它在左上角，这里和胶囊对调），**撤销 / 重做**也加进这一组 —— 胶囊只放「这张画布是什么、拿它怎么办」，不放画布内的编辑动作。
- 右侧属性面板：选中节点时编辑 `data.label` / `data.description` / `data.config`；`config` 本期用 JSON 编辑器兜底（项目里已有 CodeMirror 依赖），后续按 `kind` 出定制表单。面板展开时右上角控件组要让位（左移），不能被压在下面。

#### 4.4.2 编辑器的拆分方式

**编辑器不是一个大组件**：`FlowEditor.vue` 只负责建上下文和摆组件，功能分在两层。

- **hooks 层（`src/composables/flow/`）** —— `provideFlowEditor(props)` 建一份共享 payload 并 `provide` 出去，子组件 `useFlowEditor()` 取用，**不逐层传 props**。里面是三个各管一摊的 composable：
  | composable | 管什么 |
  |---|---|
  | `useFlowDocument` | 加载、改名、新建/复制/删除、保存状态文案、离开前落库 |
  | `useFlowCanvas` | Vue Flow 绑定：拖动 → `node.move`、连线 → `edge.add`、视口同步、Ctrl+滚轮缩放、新增节点 |
  | `useFlowSelection` | 选中态、`updateNodeData`、删除选中（连带边，合成一条撤销） |
  另有 `useFlowShortcuts(ctx)` 管快捷键和两道「别把改动弄丢」的保险。
- **组件层（`src/components/flow/`）** —— 一块界面一个组件，各自直接读上下文：`FlowCanvas`（画布本体，留了 `<slot/>` 给画布内浮层）、`FlowViewControls`（右上角控件 + 撤销/重做）、`FlowTitleCapsule`（左上角胶囊，自带删除确认）、`FlowToolbar`（底部工具栏）、`FlowNodeInspector`（右侧属性面板）。

判据：**加一块新面板 / 新工具按钮，不应该需要改 `FlowEditor.vue` 或任何中间层** —— 新建组件、`useFlowEditor()` 取上下文、挂到模板上即可。
- 快捷键：`Ctrl/Cmd+Z` 撤销、`Ctrl/Cmd+Shift+Z` 重做、`Delete` 删除选中、`Ctrl/Cmd+S` 立即保存。
- 离开页面时若仍有未提交的事务，用 `beforeunload` 拦一下。

### 4.5 Pinia store（`src/stores/flow/`）

pinia 已装在 `devDependencies`（前端整体被打包进 `output/public`，服务端 runtime 不 import 它，符合仓库的依赖切分约定）。需要在 `src/main.ts` 里 `app.use(createPinia())`。

store 的职责边界：

- **状态**：`meta`（FlowSummary 部分）、`nodes`、`edges`、`viewport`、`baseRevision`、`undoStack`、`redoStack`、`pending`（待提交事务队列）、`saveState`。
- **唯一写入口**：所有变更都通过 `apply(ops: FlowOp[], label: string)`。组件不允许直接 `nodes.push()`。
  - `apply` 做三件事：改状态 → 压入 `undoStack` → 清空 `redoStack` → 事务入 `pending`。
- **事务合并**：`beginTransaction(label)` / `commitTransaction()`，中间的 `apply` 合成一条历史；拖拽、框选批量删除走这条路。
- **撤销 / 重做**：`undo()` 取 `undoStack` 顶，用 `before`/`after` 互换后应用，压入 `redoStack`；`redo()` 反之。两者产生的事务同样入 `pending`，`kind` 分别为 `undo` / `redo`。
- **历史深度上限 100**，超出丢弃最旧的（并在 UI 上不提示）。
- **历史栈只在内存里**：刷新页面即清空，撤销不能跨会话；但画布内容本身不丢（已提交的都在库里）。这是有意为之 —— 跨会话撤销需要把栈也持久化，属于过度设计。
- **持久化**：`pending` 非空时，防抖 800ms（或累计 20 条操作、或 `Ctrl+S`）触发一次 `POST /api/flows/:id/commit`；提交期间新产生的操作进入下一批，不阻塞编辑。
- Vue Flow 的双向绑定不能绕开 store：节点拖动结束（`nodeDragStop`）、连线建立（`connect`）等事件转成 `FlowOp` 后走 `apply`。

#### 4.5.1 命令注册表（`src/stores/flow/commands/`）

**「怎么改」不写在 store 里**，否则每加一种操作都要回去改一处 `switch`。每种操作类型是一条命令，一个文件，通过 `flow/registry.ts` 按 `op.type` 查表执行：

```ts
export interface FlowCommand {
  readonly type: FlowOpType      // 注册表的键
  readonly inverse: FlowOpType   // 逆操作类型；自逆的填自己
  readonly name: string
  apply(ctx: FlowCommandContext, op: FlowOp): void
}
```

- `ctx` 只有 `{ nodes, edges, graphMeta }` 三个 ref —— 命令碰不到历史栈、提交队列这些。
- **加一种操作**：新建 `XxxCommand.ts`，往 `commands/index.ts` 的 `FLOW_COMMANDS` 加一行，其余代码一行不动。`invertOps` 也是读这张表拿的逆类型。
- 注册在 barrel 里**显式**做，不用「每个文件自带副作用」那套 —— 副作用式注册一旦被 tree-shaking 掉或 import 顺序变了，症状是「某种操作静默不生效」，极难查。同 `type` 重复注册直接抛错。
- 未注册的类型只 `console.warn` 并跳过，不抛异常：服务端将来下发更新的操作类型时，老前端不至于整张画布卡死。
- 和 `three-editor/commands` 的区别：那边是**持有对象引用的类实例**，只活在内存；这边的操作要序列化进 `FlowOperation` 落库、还要发给服务端，所以命令是**无状态处理器**，数据全在 `FlowOp` 的 `before` / `after` 里。

另有 `src/stores/project.ts` 持有当前项目与成员列表（供项目主页三个区域共享），职责简单，不涉及历史。

### 4.6 提交

> **本期不做协同**：假定一张画布在同一时刻只有一个编辑者。下面的 `baseRevision` 只是一道**兜底闸门**（防止用户自己开了两个标签页、或同项目的两个成员同时打开同一张画布时静默覆盖），不是协同方案 —— 冲突的处理就是让后来者重新加载，没有合并逻辑。

`POST /api/flows/:id/commit`：

```jsonc
{
  "baseRevision": 12,
  "transactions": [ { "id": "tx_...", "label": "移动 3 个节点", "kind": "do", "ops": [ /* FlowOp[] */ ] } ],
  "graph": { /* 客户端算好的全量 FlowGraph 快照 */ }
}
```

- 服务端在**一个数据库事务**里：校验 `baseRevision === flow.revision` → 按 `txId` 去重后追加 `FlowOperation`（`seq` 连续递增）→ 覆盖 `graph` 快照与 `nodeCount` / `edgeCount` → `revision += transactions.length`。
- `baseRevision` 不匹配 → **409**，body 带上服务端当前的 `revision`。前端的处理只有一条：提示「该画布已在别处修改，请重新加载」，然后停止自动提交（避免继续把陈旧快照往上推）。**不提供「用我的覆盖」**，也不做自动合并 —— 单编辑者假设下这是异常路径，不值得为它设计取舍界面。
- 同一 `txId` 重复提交 → 幂等，返回当前 `revision`，不重复写日志。
- 客户端为快照的权威来源（服务端不重放操作去算 graph）；日志此刻只用于审计与将来的回放。

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
| GET | `/api/projects/:id/invites` | admin | 该项目当前有效的邀请列表 |
| POST | `/api/projects/:id/invites` | admin | 生成邀请。body `{ expiresInDays?: 1\|7\|30, maxUses?: number\|null }`；**201** + `ProjectInvite`（含 token 与拼好的完整 URL） |
| DELETE | `/api/projects/:id/invites/:inviteId` | admin | 撤销（写 `revokedAt`），204 |
| GET | `/api/invites/:token` | 登录 | 邀请预览 `{ valid, reason?, projectId, projectName, memberCount, alreadyMember }`；**不校验成员身份**（被邀请者当然还不是成员），但要求已登录 |
| POST | `/api/invites/:token/accept` | 登录 | 接受，写入 `ProjectMember` 并 `usedCount + 1`，返回 `{ projectId }`；已是成员则幂等返回、不涨计数 |

**画布**

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/projects/:id/flows` | member | 项目内画布分页。query：`page`（默认 1）、`pageSize`（默认 20，上限 100）、`keyword`、`status`、`sort`（`updatedAt:desc` 等）。**响应不含 graph** |
| POST | `/api/projects/:id/flows` | member | 新建。body `{ name, description? }`；**201** + `FlowDetail`（空 graph） |
| GET | `/api/flows/:id` | member | 详情，含 graph |
| PATCH | `/api/flows/:id` | member | 改名 / 描述 / 状态 / 标签；**不能**改 graph、不能改 projectId |
| DELETE | `/api/flows/:id` | member | 软删除，204 空 body |
| POST | `/api/flows/:id/duplicate` | member | 在同项目内复制一份（名称加「副本」后缀），201；操作日志不复制，新画布 `revision` 从 0 起 |
| POST | `/api/flows/:id/commit` | member | 提交事务，见 4.6。成功返回 `{ revision }` |
| GET | `/api/flows/:id/operations` | member | 操作日志分页（`page` / `pageSize` / `sinceSeq`），供调试与将来的回放 |

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
- 邀请 `expiresInDays` 只接受 1 / 7 / 30；`maxUses` 为 null 或 1..1000 的整数。
- 单项目成员上限 200、画布上限 500、有效邀请上限 20，超出 → 400 并给出明确文案。
- `graph`：必须能被解析为 `FlowGraph`；`schemaVersion` 未知 → 400；节点 id 重复 → 400；边引用了不存在的节点 id → 400。
- 单个画布上限：节点 2000、边 4000、序列化后的 graph 2MB，超出 → 413。
- 单次 commit 的 `transactions` 上限 200 条。

## 5. 验收标准

**项目与成员**

- [ ] 新建项目后，`ProjectMember` 里存在创建者的 admin 行，成员列表能看到自己。
- [ ] 项目列表只出现我是成员的项目；别人的项目 id 直接访问返回 404。
- [ ] admin 生成邀请链接，另一个账号点开 → 看到项目名与成员数 → 点「加入」→ 落到项目主页，成员列表多一行。
- [ ] 未登录点开邀请链接 → 跳登录 → 登录后自动回到邀请确认页，而不是首页。
- [ ] 同一条邀请链接重复点「加入」不会产生第二条成员记录，`usedCount` 也不重复增长。
- [ ] 过期 / 已撤销 / 次数用尽三种失效状态给出各自的文案，不是同一句「链接无效」。
- [ ] member 调用生成邀请、移除成员、改项目名、删项目，全部返回 403。
- [ ] admin 移除自己返回 400。
- [ ] 成员被移除后，立刻访问该项目及其画布返回 404。
- [ ] 项目主页在**一个路由**内用同页 Tab 展示画布与成员；来回切 Tab 不改变 URL、不重新请求、不闪 loading。

**画布与历史**

- [ ] 画布列表能翻页，页码与关键字反映在 URL 上，刷新后状态不变。
- [ ] 列表接口的响应体里没有 `graph` 字段。
- [ ] 从画布列表点开一张画布，落到 `/flows/:id` 独立整页：**没有侧边栏**、没有项目主页的分区，画布占满视口；退回项目主页后侧边栏恢复。
- [ ] 左上角悬浮胶囊显示 logo + 画布名 + 菜单按钮；点 logo 回到所属项目主页。
- [ ] 胶囊菜单四项都可用：新建画布落到同一项目下的新画布、复制落到副本、删除后回项目主页、「返回画布首页」与点 logo 去到同一处。
- [ ] 有未保存改动时点「新建画布」，先完成提交再跳转，不丢操作。
- [ ] 新建 → 编辑 → 刷新页面，节点、连线、视口全部还原。
- [ ] 连续做 5 步操作后按 5 次 `Ctrl+Z` 回到初始状态，再按 5 次 `Ctrl+Shift+Z` 完全恢复。
- [ ] 框选多个节点一起拖动，只需一次撤销即可整体回退。
- [ ] 撤销之后再做新操作，重做栈被清空（重做按钮变灰）。
- [ ] 刷新页面后撤销栈为空、撤销按钮变灰，但画布内容完好。
- [ ] 断网时继续编辑不报错、不丢操作；恢复后自动补提交成功。
- [ ] 同项目两个成员同时打开同一张画布，后提交的一方拿到 409、给出「请重新加载」提示并停止自动提交，不会静默覆盖。
- [ ] 同一个事务重复提交（模拟网络重试）不会在 `FlowOperation` 里留下两条记录。
- [ ] 节点 `data.config` 里塞任意结构的 JSON，存取一字不差。
- [ ] A 项目的成员访问 B 项目的画布 id 返回 404；未登录访问任一 `/api/projects*` / `/api/flows*` 返回 401。

**测试覆盖**

- [ ] `server/test/routes/projects.test.ts` —— 创建即 admin、成员隔离 404、admin/member 权限分界 403。
- [ ] `server/test/routes/invites.test.ts` —— 生成、预览、接受、幂等、三种失效、次数上限。
- [ ] `server/test/routes/flows.test.ts` —— 分页、校验、跨项目 404、乐观锁 409、commit 幂等。
- [ ] `src/test/stores/flow.test.ts` —— apply / undo / redo / 事务合并 / 历史上限 100 / 防抖提交 / 409 / 断网补提交。
- [ ] `src/test/stores/flow-commands.test.ts` —— 注册表：九种内置命令齐全、每条的 `inverse` 能双向对上、重复注册报错、未知类型告警跳过、运行时新注册的命令能直接被 `apply` / `undo` 用起来。

## 6. 本期不做

- **多人实时协同编辑**（那是 [REQ-COLLAB](04-realtime-collab.md) 的事）。本期按单编辑者设计：没有在线状态、没有光标共享、没有合并策略，冲突只是「后写的人被拦下并重新加载」。
- 编辑锁 / 抢占提示（「张三正在编辑这张画布」）。
- 邮箱邀请、按用户名直接添加成员、加入申请与审批 —— **邀请链接是唯一入口**。
- 转让管理员、多管理员之外的自定义角色、画布级别的细粒度权限（项目内成员平权）。
- 主动退出项目（先只有被 admin 移除）。
- 项目层面的操作审计（谁改了项目名、谁移除了谁）。
- 操作日志的清理 —— **先只存不清**，无限增长；等量级真成问题再补清理任务。
- 软删数据的清理任务与「回收站 / 恢复」入口 —— 删了就是删了，`deletedAt` 只过滤不回收。
- 操作日志的回放与「历史版本预览 / 回滚到某个 revision」。
- 服务端重放操作重算 graph（当前信任客户端快照）。
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
