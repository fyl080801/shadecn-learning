# REQ-NODEKIT 节点扩展协议：部件 / 动作 / 模式 / 事件四张注册表

> 状态：**已实现** —— 第 1–8 步全部完成（§8）。§1.1 描述的是改造前的结构，留着是为了说明为什么要这样拆。
> §4 / §6 里的 `image-config` / `video-config` 等是写协议时的示例类型，已在第 8 步下线：现在可新建的类型只有
> `text` / `image` / `video` / `director`（[REQ-CANVAS §3.7](13-flow-canvas-management.md)）。
>
> 前置：[REQ-CANVAS §3.7.3](13-flow-canvas-management.md)（投影、`useFlowNode`）、
> [REQ-AGENT](20-agent-canvas.md)（节点类型的数据那一半在 `@shadecn/shared/flow-node-types`）。
> 本需求只动**渲染与交互那一半**；文档形状（五组 + inputs）、端口、`resolveConnection` 一概不变。

## 1. 目标与背景

### 1.1 改造前的结构

节点已经有了「基础组件 + 公共逻辑」：

```
FlowNodeBase.vue ─┬─ FlowNodeChrome.vue  （框外名字 + 双击改名 + 复制/删除工具条，#actions 插槽整排换）
                  ├─ FlowNodeHandles.vue （连接点）
                  ├─ runtime.status 角标 / 错误行
                  └─ <slot/>             （各类型的 body）
ProcessNode / TextNode / GroupNode / GenericNode = FlowNodeBase + 自己的 body + 若干 props
useFlowNode(id)   = 读四组 + 按组写 + draft
```

它解决了「每种节点都抄一遍改名、复制、删除」，但扩展点只有三种：**默认插槽、`#actions` 插槽、props**。
往下走会碰到的需求，示例数据里已经能看到：

- 生成类节点（`image-config` / `video-config` / `text-config`）要一个**底部输入框**（写 prompt、回车提交运行）；
- 素材 / 产出类节点要一块**侧边预览**（大图、视频播放），平时收着；
- 工具条上的按钮因类型而异：运行、停止、重新生成、下载产出、打开导演台……而且同一个按钮会出现在好几种类型上；
- **编辑模式**不止一种：改名、改正文、编辑 prompt、全屏编辑导演台场景 —— 它们互斥、各自决定哪些区域露出来；
- 节点上发生的事（提交了 prompt、点了运行、产出变了）需要别的东西响应：agent 面板、运行器、埋点。

照现有路子做，每一条都是给 `FlowNodeBase` 加一个 prop 或一个插槽，再在某个类型组件里填它。
结果是两种形状之一，都是这份设计要避免的：

1. **一个点多级派生**：`FlowNodeBase` → `GenerativeNodeBase`（加输入框）→ `ImageGenNode`（加预览）→ …
   能力沿着继承链往下传，「既要输入框又不要预览」就得再分一支，链越长越没法拆。
2. **一个点无限膨胀**：所有能力都塞进 `FlowNodeBase` 的 props / 插槽里，它认识每一种能力、每一个按钮，
   改哪种节点都要碰它。

### 1.2 目标

1. **依赖拍平**：节点的每一块界面、每一个按钮、每一种编辑模式、每一个事件响应，都是**一条独立注册的条目**。
   条目之间不互相 import；它们只依赖一份很薄的协议（注册表 + 上下文），由协议按规则组合到节点上。
2. **节点类型 = 一份声明**，不是一个组件：声明它的外形、它要哪些能力（feature）、它的 body 是谁。
   加一种「既要输入框又要预览」的节点，是在声明里多列两个能力名，不是新写一层基类。
3. **能力可复用、可替换、可关闭**：同一个能力挂到任意类型上；某种类型可以按 id 换掉或去掉某一条（分组把「删除」换成「解组」）。
4. **节点行为走事件**：部件通过 `emit` 发出语义事件，响应方在注册表里按事件名登记处理函数；
   发的一方不知道谁在听，听的一方不知道谁在发。
5. 对现有节点**零行为变化**：迁移完成时，`ProcessNode` / `TextNode` / `GroupNode` / `GenericNode` 的表现、测试全部不变。

## 2. 核心概念

四张开放的注册表 + 一组封闭的区域 + 一个能力打包单位：

| 概念 | 是什么 | 开放 / 封闭 | 例子 |
|---|---|---|---|
| **区域 Slot** | 节点上一个固定的挂载位置，**几何与露出规则由宿主决定** | **封闭**（宿主定义） | `label` `toolbar` `header` `body` `footer` `composer` `side` `badge` `overlay` |
| **部件 Part** | 挂到某个区域里的一个组件 | 开放 | 名字标签、状态角标、错误行、拉伸手柄、prompt 输入框、产出预览 |
| **动作 Action** | 一个可触发的「工具」：图标 + 名字 + `run` + 可用条件 + 快捷键 | 开放 | 复制、删除、解组、运行、下载 |
| **模式 Mode** | 节点的一种编辑状态：互斥、进入 / 退出钩子、可改变区域露出 | 开放 | `rename`、`edit-body`、`edit-prompt` |
| **事件 Event** | 一个带类型的语义消息，部件 `emit`、处理函数订阅 | 开放 | `composer:submit`、`node:run`、`mode:enter` |
| **能力 Feature** | 上面四种条目的**打包**，节点类型按名字选用 | 开放 | `rename`、`duplicate`、`runnable`、`output-preview`、`resizable` |

两条决定性的取舍：

- **区域封闭、条目开放。** 区域是几何：它在画布上的哪里、什么时候露出、和别的区域怎么不打架
  （现在 `FlowNodeChrome` 里 `TOOLBAR_OFFSET = LABEL_OFFSET + 20 + 6` 这种堆叠就是区域之间的事）。
  几何如果也让每个部件自己说了算，就回到了「每个部件各自 absolute」的老问题（CLAUDE.md：画布定位交给 Vue Flow）。
  所以区域只有宿主能加，部件只能**选一个区域、给一个 `order`**。
- **组合单位是能力，不是类型。** 部件 / 动作 / 模式匹配的是「这个节点有没有某个能力」，
  而不是「这个节点是不是某个类型或它的子类」。类型之间没有任何派生关系，能力之间也没有。

## 3. 依赖结构

```
                    ┌──────────────────────────────────────────┐
                    │ node-kit/protocol.ts（叶子，只有类型 +   │
                    │   defineXxx 工厂 + 注册表实现，不 import  │
                    │   任何组件、任何 feature、任何 store）    │
                    └──────────────────────────────────────────┘
                          ▲            ▲                ▲
         ┌────────────────┘            │                └────────────────┐
         │                             │                                 │
 features/rename.ts           features/runnable.ts  …          node-kit/NodeHost.vue
 features/output-preview.ts   features/resizable.ts            node-kit/NodeSlot.vue
 （每个 feature 只 import 协议 + 自己的部件组件 +             （宿主只 import 协议，
   store / editor 的**类型**；feature 之间互不 import）          不认识任何 feature）
         ▲                             ▲
         └─────────────┬───────────────┘
                       │
             node-kit/install.ts  —— 唯一一个列出全部 feature 的文件（一行一个 register）
                       ▲
                       │
             node-types.ts  —— 节点类型声明：features 写**名字字符串**，不 import feature 模块
```

规矩：

1. **`protocol.ts` 是叶子**，和 `editor-context.ts`、`node-view.ts` 同一个理由 —— 节点组件、部件组件、宿主都要引它，
   它一旦反向 import 任何组件就会成环，而环只在 rollup 生产构建里炸（`CYCLIC_CROSS_CHUNK_REEXPORT` 已提成错误）。
2. **feature 之间不 import。** 一个 feature 要和另一个配合，只能通过 ① 事件 ② 节点上下文里的公共协议（`mode`、`node`、`editor`）。
   底部输入框提交时 `emit('composer:submit')`，`runnable` 订阅它发起运行 —— 两者都不知道对方存在。
3. **节点类型引能力用名字**（`features: ['rename', 'runnable']`），在 `install.ts` 注册时校验名字存在。
   这样 `node-types.ts` 不再 import 一堆组件，现在那个「常量要拆到 `node-constants.ts` 去断环」的问题会自然消失一半。
4. **宿主不认识任何具体能力或类型**（延续 `FlowNodeBase` 现在「没有 `if (type === 'group')`」的规矩）。

## 4. 协议

下面是 API 形状的草图，名字可以再议，关系是要守的。

### 4.1 节点类型声明

```ts
// node-types.ts —— 数据那一半仍然从 shared 的 FLOW_NODE_TYPE_DEFAULTS 铺进来
export const FLOW_NODE_TYPES = {
  text: defineNodeType('text', {
    label: '文本', icon: Type,
    shell: 'card',                             // card | frame：外壳底色/边框/内边距由谁给
    body: TextBody,                            // 唯一必填的视图：区域 body 的默认部件
    features: ['rename', 'duplicate', 'delete', 'connectable', 'status', 'edit-body'],
    class: 'flex min-h-[120px] w-[320px] flex-col'
  }),
  group: defineNodeType('group', {
    label: '分组', icon: Frame, shell: 'frame',
    body: GroupBody,
    features: ['rename', 'ungroup', 'resizable', 'drag-strip'],   // 没有 connectable / duplicate / delete
  }),
  'image-config': defineNodeType('image-config', {
    label: '图片生成', icon: ImagePlus, body: GenericBody,
    features: ['rename', 'duplicate', 'delete', 'connectable', 'status',
               'runnable', 'output-preview'],
  parts: [imagePromptComposer],                // 类型专属部件：只有这个类型有这个底部输入框
  }),
  'video-config': defineNodeType('video-config', {
    label: '视频生成', icon: Film, body: GenericBody,
    features: [/* 同上 */],
    parts: [videoPromptComposer],              // 视频的输入框多一个时长 / 比例，和图片的不是同一个
  }),
}
```

- **按类型注册**有两种写法，效果相同（部件只挂到指定类型上）：
  ① 类型声明里的 `parts: [...]` —— 只属于这一个类型的部件，就近写在声明旁；
  ② 部件 / 能力上写 `match: { types: ['image-config', 'video-config'] }` —— 同一个部件给少数几个指定类型用。
  `features` 用于「很多类型都要、长得一样」的东西（改名、删除、连接点），**底部输入框不属于这一类**：
  哪些类型有、每个类型的输入框里有什么，都因类型而异，所以按类型注册，不做成一个人人可选的通用能力。
- **`component` 退场，统一换成 `NodeHost`**：`flowNodeComponents` 里每个 type 都指向同一个宿主组件，
  宿主按 `props.type` 查声明。类型自己的 UI 只剩 `body`（以及它自己注册的部件）。
- 常用组合可以提成**预设**（`const STANDARD = ['rename', 'duplicate', 'delete', 'connectable', 'status']`），
  预设只是一个字符串数组，展开后与手写无异 —— 它不是基类，类型之间仍然没有关系。

### 4.2 区域（宿主定义，封闭）

| 区域 | 位置 | 定位方式 | 默认露出规则（宿主决定） |
|---|---|---|---|
| `label` | 框外左上 | `NodeToolbar` Top / start | 常开 |
| `toolbar` | 框外上方居中，`label` 之上 | `NodeToolbar` Top / center | **单独选中 + 不在拉框**（即现在 `FlowNodeChrome` 的 `showToolbar`） |
| `badge` | 卡片内右上角 | 卡片内 absolute（节点自身外观，不是画布定位） | 常开（部件自己 `when`） |
| `header` | 卡片内，body 之上 | 文档流 | 常开 |
| `body` | 卡片内 | 文档流 | 常开 |
| `footer` | 卡片内，body 之下 | 文档流 | 常开 |
| `composer` | 框外下方 | `NodeToolbar` Bottom / center | **只对注册了 composer 部件的类型存在**；存在时：单独选中，或有模式要求露出 |
| `side` | 框外右侧 | `NodeToolbar` Right / start | **只在被要求时**（模式或 `slots.open('side')`） |
| `overlay` | 覆盖整个节点 | 卡片内 absolute inset-0 | 部件自己 `when` |
| `handles` | 左右两侧 | `Handle` | 由 `connectable` 能力提供，宿主只留位置 |

- 框外的区域一律用 Vue Flow 的 `NodeToolbar` / `Handle`，**一个区域一个 `NodeToolbar`**，区域内多个部件在里面按 `order` 用 flex 排，
  不再靠偏移量把多个独立浮层「算」到一起。`label` 与 `toolbar` 的上下堆叠是宿主里唯一保留的偏移计算。
- 「露出规则」分两层：**宿主决定这个区域此刻能不能出现**（几何与交互约定，比如拉框时任何工具条都不出现），
  **部件的 `when` 只能在此基础上再收窄**，不能放宽。这样不会有部件在拉框时偷偷冒出来。
- 区域里一个部件都没有（或都 `when=false`）时，宿主**不渲染这个 `NodeToolbar`**，几十个节点不会挂着几十个空浮层。
- **区域是「可以挂东西的位置」，不是「每个节点都有的东西」。** 除了 `body`（类型必填）和宿主内置的名字 / 在场头像，
  一个区域在某个节点上存不存在，完全取决于**这个节点的类型有没有注册部件到那里**。
  以底部输入框为例：`process` / `group` 没有注册任何 `composer` 部件，它们就没有底部输入框 ——
  不是「有但隐藏」，而是解析结果为空、宿主连 `NodeToolbar` 都不挂；进入任何模式、调用 `slots.open('composer')` 也变不出来。

### 4.3 部件

```ts
export const statusBadge = defineNodePart({
  id: 'status.badge',
  slot: 'badge',
  order: 100,
  component: StatusBadge,                       // 组件里 useNodePart() 拿上下文
  when: (ctx) => ctx.node.runtime.value.status === 'processing',
})
```

- **`order` 分段**，避免数字战争：0–99 宿主 / 框架内置，100–499 通用能力，500+ 类型专属。同 `order` 按注册顺序。
- **`replaces: '<part id>'`** 显式替换另一个部件；**`hides: ['<id>']`** 显式去掉。没有「优先级更高的自动覆盖」，
  替换关系必须写名字，读声明就能知道最终挂了什么。
- 部件组件**不收 props**，一律 `useNodePart()` 取上下文（下一节）。部件常常被 teleport 到画布容器上（`NodeToolbar`），
  靠 props 层层传会让宿主认识每个部件要什么。
- 重的部件（预览播放器、导演台编辑器）用 `defineAsyncComponent`，区域不露出就不加载。

### 4.4 节点上下文（部件、动作、模式、事件处理函数共用的唯一入口）

```ts
interface NodePartContext {
  id: string
  type: string
  def: FlowNodeTypeDef                 // 类型声明（features、label、icon）
  node: FlowNodeHandle                 // 就是现在的 useFlowNode(id)：读四组、按组写、draft
  editor: FlowEditorContext            // canvas / selection / presence / store（已有）
  selected: Readonly<Ref<boolean>>
  mode: NodeModeState                  // 4.6
  slots: { open(slot), close(slot), isOpen(slot) }   // 只对「被要求才露出」的区域有意义
  has(feature: string): boolean
  emit<K extends keyof FlowNodeEventMap>(event: K, payload: FlowNodeEventMap[K]): void
}
```

- 宿主 `provide` 一次，`useNodePart()` 注入；`NodeToolbar` 的 teleport 不影响 provide/inject（它在组件树里仍是宿主的子孙）。
- **读写规则不变**：读 `ctx.node`（直接读 store，不读 Vue Flow 冻结的 `data` prop），写走 `ctx.node.write` / `draft`
  → `store.writeNode` → `store.mutate`。部件拿不到 Y.Map。
- `has(feature)` 只用于**降级**（「有 `runnable` 才显示运行按钮」那种），不是用来写 `if` 分支替代注册的。

### 4.5 动作（工具）

```ts
export const duplicateAction = defineNodeAction({
  id: 'node.duplicate',
  slot: 'toolbar',                 // toolbar | footer | composer | menu（将来的右键菜单）
  order: 100,
  icon: Copy, label: '复制节点',
  shortcut: 'Mod+D',
  when: (ctx) => true,             // 不满足就不出现
  enabled: (ctx) => true,          // 出现但置灰
  run: (ctx) => ctx.editor.canvas.duplicateNode(ctx.id),
})
```

- 动作**不是部件**：每个区域里由宿主内置的一个 `ActionBar` 部件统一渲染该区域的动作（圆按钮、`title`、`loading`），
  所以新加一个工具只写数据，不写模板，按钮长一个样。需要特殊外观的（下拉选模型）就别做成动作，做成部件。
- **异步动作**统一走编辑器级的一个执行器（`node-kit/actions.ts`，内部是 `useAsyncAction`，key = 节点 id × 动作 id）：
  按钮和快捷键共用它，「一次点击一次请求」对两条入口都成立，按钮的 `loading` 由它驱动。`run` 不需要自己 try/catch。
- **快捷键**由 `useFlowShortcuts` 统一分发：只对**当前单独选中的节点**、只在非输入态（`isEditableTarget`）下，
  按快捷键查该节点可用的动作、调它的 `run`。编辑器自己的全局键（撤销 / 重做 / 保存 / 删除）先判，节点动作抢不走；
  只认**此刻出现**的动作（`when`），命中但置灰的照样接走、不执行（落空的 `Mod+D` 也不该弹出浏览器的加书签）。现在 `Delete` 走 `deleteSelection` 的多选路径不变 —— 多选的动作属于选区工具栏，不在本协议里。
- 每次 `run` 前后宿主各发一个事件：`action:invoke`（`{ action }`）和 `action:done`（`{ action, error? }`），
  这是「给工具扩展行为」的入口：想在「删除」之后做点什么，订阅事件，不去改「删除」这个动作。
  **第一版事件只通知、不拦截**；要让某个类型不能删，是在它的声明里去掉 `delete` 能力，而不是挂一个否决钩子。

### 4.6 模式（编辑状态）

```ts
export const editPromptMode = defineNodeMode({
  id: 'edit-prompt',
  reveal: ['composer'],            // 进入时强制露出这些区域
  conceal: [],                     // 可选；进入时收起这些区域（edit-prompt 不收：节点选中期间工具栏一直显示）
  enter: (ctx) => {},              // 可选；聚焦之类的副作用
  exit: (ctx, reason) => {},       // reason: 'commit' | 'cancel' | 'preempted'
})
```

- **整张画布同一时刻只有一个节点可编辑**（已定，§10.2）：模式状态是**编辑器级的一个值**
  `{ nodeId, mode } | null`，不是每个节点各存一份，`ctx.mode` 只是它在本节点上的视图。
  由此两条：
  - **选中另一个节点，上一个节点的编辑就取消**（以 `'preempted'` 退出）。编辑中的节点一定是被选中的那个，
    快捷键分发、将来的 awareness 上报都只需要看这一个值。
  - 同一节点上进入新模式，旧模式同样以 `'preempted'` 退出（改名时双击正文，改名先退出）。
- `'preempted'` 退出时草稿**提交**（与现在一致：点别处 → 输入框 blur → `useDraftField.commit()`；
  `useDraftField` 已经处理了 Enter 与 blur 双发）。只有 Esc 这类显式 `'cancel'` 才丢草稿。
- 模式状态**是本地 UI 状态，不进文档、不进撤销**；模式里产生的内容仍然按「草稿 + 结束时一次提交 + 前后 `separateUndo`」那套写。
  模式和 `useDraftField` 的关系：draft 管「一个字段的值」，模式管「整个节点现在处于哪种交互」；
  一个模式里可以有零到多个 draft，`exit` 时由模式决定 commit 还是 cancel。
- 将来要让别人看到「谁在编辑这个节点的 prompt」，是给 awareness 加一个 `editing: { nodeId, mode }` 反馈字段 —— 本期不做。

### 4.7 事件

```ts
// 事件类型用模块扩充（declaration merging），每个 feature 在自己文件里声明自己的事件，没有中心枚举文件
declare module '@/components/flow/node-kit/protocol' {
  interface FlowNodeEventMap {
    'composer:submit': { text: string }
  }
}

// 发
ctx.emit('composer:submit', { text })

// 收 —— 注册在 feature 里，或者任何编辑器级的 composable 里
defineNodeHandler({
  event: 'composer:submit',
  match: { features: ['runnable'] },          // 只处理带这个能力的节点发出的
  handle: (payload, ctx) => ctx.emit('node:run', { prompt: payload.text }),
})
```

- **为什么不用 Vue 的组件 `emit`**：部件散在多个 teleport 出去的浮层里，组件事件只到直接父级、不冒泡；
  而响应方往往根本不在节点组件树里（agent 面板、运行器）。所以事件是一条**编辑器级的总线**：
  `Map<event, Set<handler>>`，按事件名分桶，不是每个节点一个实例。
- 语义：**同步、广播、无返回值**。每个处理函数独立 try/catch，一个抛错只记日志（`console.error('[node-kit] …')`），
  不影响别的处理函数，也不往发出方抛 —— 与服务端「观察者不得打断钩子链」同一条原则。
- **事件不是写入通道**：处理函数要改文档，照样走 `ctx.node.write` / `store.mutate`，于是照样进撤销、照样同步。
  事件本身不进文档、不跨客户端 —— 它描述的是「这个客户端上发生了一次交互」，不是数据。
- **事件名没有强制的命名规则**（已定，§10.3）：不要求 `<feature>:<event>` 前缀，注册时也不校验格式。
  本文里的 `composer:submit` 只是写法习惯；防撞名靠 `FlowNodeEventMap` 的类型扩充 —— 两处声明同一个键、载荷类型不一致时，编译期就会报错。
- 内置事件（宿主发）：`node:select` / `node:dblclick` / `mode:enter` / `mode:exit` / `action:invoke` / `action:done` / `slot:open` / `slot:close`。
  双击不再由各节点组件自己 `@dblclick` 决定进哪个模式：宿主发 `node:dblclick`，带 `edit-body` 能力的节点由该能力的处理函数进入模式。
  于是「双击做什么」也是可组合的。
- 处理函数可以注册在两个层次：**能力里**（随能力启用）和**编辑器级**（`useFlowAgent` 之类在 setup 里 `onNodeEvent(...)`，
  随组件卸载自动注销）。后者是外部系统接入节点行为的唯一方式。

### 4.8 能力（打包单位）

```ts
export const runnable = defineNodeFeature({
  id: 'runnable',
  parts:    [statusBadge, errorFooter],
  actions:  [runAction, stopAction],
  modes:    [],
  handlers: [onRunRequest],          // 订阅 node:run → 调运行器
})
```

- 能力是**纯数据的打包**：一组部件 + 一组动作 + 一组模式 + 一组处理函数，外加可选的 `rootClass(ctx)` ——
  部件够不着节点根元素，而「运行中的一圈高亮 / 出错的红框」这类外观又确实属于某个能力，由宿主收集后合到根上。它不继承别的能力、不 import 别的能力。
- 匹配：部件 / 动作 / 处理函数默认对「启用了它所属能力的节点」生效；也可以显式写 `match: { types, features, not }`
  —— 比如 `output-preview` 的部件只对端口里有 `image` / `video` 输出的类型生效。
  `match` 是**静态**的（只看类型声明），宿主按 `type` 把一个区域最终挂哪些条目**解析一次缓存住**；
  `when` 是**动态**的（看节点数据、选中、模式），每次渲染算。画布上几百个节点，解析不会重复做。

### 4.9 注册表实例与测试

- 注册表由 `createNodeKit()` 创建，编辑器里 `provide`；`install.ts` 往默认实例里装全部能力。
  **不是模块级单例** —— 组件测试 `createNodeKit()` 一个干净的、只装要测的那一个能力，不会被别的测试装进去的东西污染
  （和 `resetProjectNav()` 那种模块缓存在测试里要手动复位的问题划清界限）。
- 协议层是纯函数，单测不需要挂载：「某类型的 `toolbar` 区域最终解析出哪几个动作、什么顺序」「`replaces` 生效」
  「`hides` 了不存在的 id 在注册时报错」「事件处理函数抛错不影响其他处理函数」。

## 5. 现有节点怎么映射

| 现在 | 之后 |
|---|---|
| `FlowNodeBase.vue` | `NodeHost.vue`：外壳 + 九个区域 + provide 上下文；`variant` → 类型声明的 `shell` |
| `FlowNodeChrome` 的名字 + 双击改名 | 能力 `rename`：部件 `label.title`（`label` 区）+ 模式 `rename` + 处理函数 |
| `FlowNodeChrome` 的在场头像 | **宿主内置**（`label` 区，`order` 在名字之后），所有节点强制显示，**不是能力、类型不能关**（§10.4）；个人画布上 presence 本来就不运行，自然为空 |
| 复制 / 删除按钮 | 能力 `duplicate` / `delete`，各一个动作 |
| `GroupNode` 的 `#actions` 换成解组 | 能力 `ungroup`：一个动作。分组不启用 `delete`，所以没有「替换」要写 |
| `FlowNodeHandles` | 能力 `connectable`（`handles` 区）；`connectable=false` 这个 prop 消失 |
| `runtime.status` 角标 / 错误行 | 能力 `status`：`badge` 区一个部件、`footer` 区一个部件 |
| `GroupNode` 的 `NodeResizer` | 能力 `resizable`：`overlay` 区一个部件，`resize-end` 写 `store.resizeNode` |
| `GroupNode` 的顶部拖动把手 | 能力 `drag-strip`：`overlay` 区一个部件 |
| `TextNode` 的双击编辑正文 | 能力 `edit-body`：模式 `edit-body` + 订阅 `node:dblclick`；`TextBody` 读 `ctx.mode` 决定渲染 textarea 还是段落；该模式 `conceal: ['composer']`，改正文期间底部输入框收起 |
| `GenericNode` 的输出预览 | body 里那段拆成能力 `output-preview`（`footer` 区），同一个部件之后可以搬到 `side` 区做大预览 |

`selectedClass` / `idleClass` / `frameStyle` 这几个 prop 是外壳外观，挂到类型声明上（`shell` 的附加选项），
分组的底色是数据，所以仍是一个从 `ctx.node.data` 算 `style` 的函数。

## 6. 第一批新能力（让协议有真实消费者）

协议没有消费者就是空设计。第一版跟着做两个，各自覆盖一个新区域：

1. **底部输入框（按类型注册）**：先给 `image-config` 注册一个 `composer` 区部件（类型声明的 `parts`），编辑 `data.prompt`
   （走 `draft`，回车提交、Shift+Enter 换行、Esc 取消），提交时 `emit('composer:submit', { text })`，它不知道运行是什么。
   `video-config` / `text-config` 各自注册自己的输入框；三者共用的只是输入框的**零件**（一个 `PromptComposerShell.vue` 组件，
   被各类型的部件组件引用 —— 这是普通的组件复用，不进注册表），不是同一条注册。
   节点同时启用 `runnable` 时，`runnable` 的处理函数接住 submit。
2. **`output-preview`（侧边预览）**：`footer` 区一个缩略图部件 + `side` 区一个大预览部件 + 一个「展开预览」动作（`slots.open('side')`）。
   复用 `GenericNode` 里现有的 `imageSrc` 识别逻辑。

`runnable` 第一版只到「发出 `node:run`」为止 —— 真正的运行器（谁执行、怎么回写 `runtime`）是另一个需求，
这里的价值是证明「输入框 → 事件 → 运行请求」三方互不 import 也能串起来。所以第一版**没有「运行」/「停止」按钮**
（运行器没接上，点了没反应），运行器落地时作为 `runnable` 的动作加上。

## 7. 验收标准

1. 现有四种节点组件的行为、`FlowNodeBase.test.ts` 及相关组件测试迁移后全部通过（测试可以改挂载方式，断言不变）。
2. `NodeHost.vue` 与 `protocol.ts` 中**没有任何具体类型名或能力名**（grep 可验证）。
3. `features/*` 之间没有相互 import（可用 eslint `no-restricted-imports` 按目录固化）。
4. 新增「既有输入框、又有侧边预览、没有删除按钮」的节点类型，**只改 `node-types.ts` 一处**（+ shared 的数据默认值）。
5. 给所有带 `runnable` 的节点加一个工具栏按钮，只新增一个动作文件并在 `runnable` 能力里列出，不碰任何节点或宿主文件。
6. 外部 composable 能订阅某类节点的事件，组件卸载后处理函数自动注销（测试可验证注销后不再被调用）。
7. 拉框期间任何框外区域都不出现；进入 `edit-prompt` 模式时 `composer` 露出、`toolbar` 照常显示（节点选中期间工具栏一直在）；
   整张画布同时最多一个节点处于编辑态，选中另一个节点时上一个节点的编辑取消（以 `preempted` 退出，草稿按 blur 提交）。
10. 每个节点都显示在场头像，任何类型声明都无法去掉它。
11. 没有注册 `composer` 部件的类型（`process` / `group`）选中后**没有**底部输入框，DOM 里也没有对应的 `NodeToolbar`；
    给某个类型加底部输入框只改它自己的声明（或一个 `match.types` 指向它的部件），其他类型不受影响。
8. 区域内没有可见部件时不渲染对应的 `NodeToolbar`（DOM 断言）。
9. 生产构建无循环依赖告警（`CYCLIC_CROSS_CHUNK_REEXPORT` 仍是错误）。

## 8. 迁移顺序

每一步都可单独合入、行为不变：

1. ✅ 协议层 + 纯函数单测：`node-kit/protocol.ts`（类型、`define*`，只有 `import type` 的叶子）、`node-kit/registry.ts`（`createNodeKit()`：解析与缓存、装配期校验、事件总线）、`node-kit/modes.ts`（编辑器级的模式状态机：同时只有一个节点可编辑、选中别的即 preempted）；测试在 `apps/web/src/test/components/node-kit/`。
2. ✅ 宿主：`node-kit/NodeHost.vue`（建上下文并 provide、按类型解析各区域、框外 `composer` / `side` 的露出规则、解析为空不挂 `NodeToolbar`）、`NodeSlot.vue`、`ActionBar.vue`（`useAsyncAction` + `action:invoke` / `action:done`）、`context.ts`（`provideNodeKit` / `useNodePart`，没 provide 时用空注册表）、`install.ts`（`createDefaultNodeKit()`，暂时为空）；`provideFlowEditor` 里 provide 一份，选中态变化接到模式状态机。`FlowNodeBase` 成了转发 props / 插槽的薄包装，类型组件未改。过渡期 `label` / `toolbar` 两个区域仍由 `FlowNodeChrome` 定位：它的操作栏露出改由宿主传入（`toolbarVisible`），并多了 `#label-extra` / `#toolbar-extra` 两个插槽承接注册的部件和动作，第 3 步拆掉。
3. ✅ 拆成能力（`node-kit/features/`）：`rename`（`label` 区的名字 + `rename` 模式，被顶掉时按 blur 规矩提交）、`duplicate` / `delete`（工具条动作，删除用 `tone: 'destructive'`）、`connectable`（`handles` 区，包一层现有的 `FlowNodeHandles`）、`status`（`badge` 区角标 + `footer` 区错误行 + 能力的 `rootClass` 给根元素加高亮 / 红框）；在场头像是宿主内置的 `NodePresence`。`node-types.ts` 的每个类型多了 `features`（默认 `STANDARD_NODE_FEATURES`，分组只有 `rename` + `status`），`install.ts` 按它登记类型。宿主自己定位 `label` / `toolbar` 两个区域，`FlowNodeChrome` 删除，`connectable` prop 消失；分组的「解组」暂时仍走 `#actions` 插槽。
4. ✅ 分组拆成能力 `ungroup`（工具条动作）/ `resizable`（`overlay` 区的 `NodeResizer`）/ `drag-strip`（`overlay` 区的顶部把手），文本的双击编辑成了 `edit-body`（接 `node:dblclick`、进 `edit-body` 模式，`TextBody` 看模式开草稿；载荷是 `{ event }`，要拦冒泡的处理函数自己 `stopPropagation`）。类型声明的 `component` 换成 `view`（`NodeTypeView`：`body` / `shell` / `class` / `selectedClass` / `idleClass` / `style(ctx)` / `fallbackLabel`），经 `registerType` 进注册表、宿主按 `kit.viewOf(type)` 画；`flowNodeComponents` 每个 type 都是 `NodeHost`。删除 `FlowNodeBase` / `ProcessNode` / `TextNode` / `GroupNode` / `GenericNode`，body 是 `TextBody.vue` / `GenericBody.vue`（流程节点和分组没有 body）。演示页 `FlowChart.vue` 原本借用 `ProcessNode`（它要编辑器上下文，那里其实一直跑不起来），改用 Vue Flow 内置的 default 节点。
5. ✅ 动作快捷键：`node-kit/shortcut.ts`（写法 `Mod+D` / `Mod+Shift+G` / `F2`，修饰键只认 `Mod`（Meta 或 Ctrl）/ `Shift` / `Alt`，精确匹配；写错的在 `validate()` 里报出），`node-kit/actions.ts` 是编辑器级唯一的动作执行器（按钮和快捷键同一把「一次一请求」锁、同一对 `action:invoke` / `action:done`），宿主把自己的上下文登记到 `runtime.hosts`，`useFlowShortcuts` 在自己的全局键（撤销 / 重做 / 保存 / 删除）之后把按键交给**单独选中**的节点（`FlowEditorContext.nodeKit.dispatchShortcut`）。复制 = `Mod+D`，解组 = `Mod+Shift+G`；按钮的 title 带上快捷键。双击改走 `node:dblclick` 已在第 4 步完成。
6. ✅ 第一批新能力：`image-config` 的底部输入框按类型注册（类型声明的 `parts` + `modes`；`NodeKitTypeDef` 为此多了 `modes`），外壳是 `components/flow/composer/PromptComposer.vue`（草稿写 `data.<field>`，回车提交并发 `composer:submit`、**输入法组字时的回车不算**、Shift+回车换行、Esc 丢草稿、失焦只写回；写字即进 `edit-prompt` 模式——露出输入框，工具条照常显示；浮层收起导致卸载时也按失焦写回）。`output-preview`：`footer` 区的产出列表（从 `GenericBody` 挪出来）+ `side` 区原图大预览 + 「展开 / 收起预览」两个按 `when` 出现的动作。`runnable`：只有一个处理函数，把非空的 `composer:submit` 转成 `node:run`——**不加「运行」按钮**，运行器没接上时点了没反应的按钮比没有更糟。`composer:submit` / `node:run` 两个事件都用模块扩充各自声明在自己的文件里。
7. ✅ 文档：REQ-CANVAS §3.7.3 / §4.4（宿主 + 类型声明 + 能力、组件层清单、节点动作快捷键）、REQ-AGENT 里的占用标签、CLAUDE.md 的节点注册表与组件清单，并新增一条 node-kit 协议的说明。
8. ✅ 节点类型收敛为四种：`text` / `image` / `video` / `director`（shared 的 `CREATABLE_NODE_TYPES`；七种样例业务类型下线，老画布里的按兜底 `process` 显示）。
   - 每种类型往 `body` 区登记自己的内容：`TextBody`（输入框样子的正文区）/ `ImageBody`（`data.src` 的图，空时可上传）/ `VideoBody`（只画 `data.poster`，没视频时可上传）/ `DirectorBody`（「打开导演台」按钮，先空着）；`GenericBody` 删除。
   - 底部输入框按类型登记（`composer/composer-part.ts` 的 `definePromptComposerPart`，写 `data.prompt`）：文本 / 图片 / 视频有了内容（shared 的 `hasNodeResource`）就收起，导演台一直有；`ImagePromptComposer` 删除。（后续：图片 / 视频改为看形态 `nodeFormOf`——generate 形态输入框常驻，asset 形态才收起，见 docs/13 §3.7；只有文本仍按有无内容收起）
     `edit-prompt` 模式改成**能力**（`composer/prompt.ts` 的 `editPromptFeature`）：模式 id 在注册表里全局唯一，四个类型不能各登记一份。
   - 提交只发 `composer:submit`，没有类型启用 `runnable`，所以眼下提交不触发运行；`runnable` / `output-preview` 仍在 `install.ts` 登记，作为通用能力留着。
   - 连接点：入口 `connectable-start=false`、没有加号；出口点加号 / 拉线到空白处弹出候选类型菜单（`FlowGrowMenu`），不再自动长节点。

## 9. 本期不做（Out of Scope）

- **运行器**：`node:run` 之后谁执行、怎么回写 `runtime.status` / `outputs`。
- **事件拦截 / 否决**（`before*` 钩子能取消动作）。第一版用「不启用这个能力」表达「不能做」，等真有「条件性禁止」的需求再加，
  且要先回答多个否决者的顺序问题。
- **模式的协同可见**（awareness 上的 `editing` 字段）。
- **运行时动态启用 / 关闭能力**（按用户设置、按画布）。能力列表只来自类型声明。
- **右键菜单**：`menu` 区只在动作的 `slot` 枚举里占个位，宿主暂不实现。
- **把能力列表下沉到 `@shadecn/shared`**：能力是渲染侧概念，agent 不需要知道「这个节点有没有输入框」。
  若将来 agent 需要知道「能不能运行」，那是数据侧的语义，应在 shared 里单独声明，而不是共享这份前端注册表。
- **选区（多选）工具栏**接入动作协议。`FlowSelectionToolbar` 保持原样，它的动作针对的是一片节点，签名不同。

## 10. 已定事项

1. **`composer` 和 `side` 放在节点框外**（`NodeToolbar`）。节点尺寸是布局数据，随选中出现的输入框 / 预览不能让节点变高、
   盖住下方节点或让分组外框失准；它们也不参与框选、不出现在小地图里。
2. **整张画布同一时刻只有一个节点可编辑；选中另一个节点，上一个节点的编辑取消**（§4.6）。
   「取消」指退出编辑态；草稿按现有 blur 行为提交，只有 Esc 丢弃。
3. **事件名不带固定的前缀规则**，注册时不校验格式（§4.7）。
4. **在场头像一律显示**：宿主内置，不做成可选能力（§5）。
5. **底部输入框按类型注册，不是所有节点都有**（§4.1、§4.2）：区域只对注册了部件的类型存在；输入框因类型而异，不做成通用能力。
   它用的编辑模式 `edit-prompt` 例外，是一个能力（§8 第 8 步）：模式是「交互状态」，各类型一样，而模式 id 全局唯一。
