# REQ-AGENT-SKILL Agent 内置技能：按能力集组织工具

> 状态：**部分实现**：注册表、`load_skill`、首批四个技能（`canvas` / `canvas-edit` / `media-view` / `media-exec`）、
> 会话记住技能、节点范围会话的契约与路由、导演台的 `director` 技能（写 + 量）已做；`director-view`、`director-script` 待做（节点范围会话的前端入口随导演台界面一起做）。
> **规划变更**：取消节点范围会话，所有会话都是全局 agent（[REQ-AGENT](20-agent-canvas.md) §3.10.9）；`canvas` 与 `canvas-edit` 合成一个 `canvas`（§4），`boundNode` 随之去掉。
>
> 前置：[REQ-AGENT](20-agent-canvas.md)（画布 agent、原子操作层、常驻观察）、
> [REQ-AGENT-SANDBOX](22-agent-sandbox.md)（runner / 网关 / 授权）。
> 第一个新增的技能是导演台，场景数据与时间轴见 [REQ-DIRECTOR](07-director-console.md) §7。

## 1. 目标与背景

现在 agent 每一轮都把**全部**工具交给模型：13 个画布工具，加上按条件出现的 `view_node_media`、`run_media_command`。
系统提示也是一整段，只有「能不能看图」这一处按条件追加（`systemPromptFor({ viewMedia })`）。

工具会越来越多。导演台一项就要再加十几个（§4），往后还有音频、视频剪辑、生成类节点。全部平铺有三个问题：

1. **每次模型请求都要重发全部工具定义和系统提示**。一轮十几次请求，这笔 token 是固定开销，和这一轮用不用得上无关。
2. **工具多了模型会选错**：名字相近（`update_node` 与 `update_director_objects`）、职责重叠，提示词越写越长，规则互相打架。
3. **条件判断散落各处**：「模型吃不吃图」「有没有配对象存储」「Grant 里有没有 `sandbox:exec`」「工具在网关执行还是在 runner 执行」，
   目前分别写在 `session.ts` 和 `runner/index.ts` 的 if 里，新增一类工具就要两边各加一段。

所以要把工具按**能力集**组织起来，这就是**内置技能（Skill）**：一组原子工具，加上配套的提示段、所需能力、可用条件和执行位置，
作为一个整体被提供、加载和展示。底层仍是 pi 的 `Agent` 和 `AgentTool`，不引入新的 agent 框架。

## 2. 名词

| 名词 | 含义 |
|---|---|
| **内置技能**（Skill） | 平台随代码提供的能力集：工具 + 提示段 + 所需能力 + 可用条件。由开发者编写，和工具一样受版本管理 |
| **工具**（Tool） | 不变：一个原子操作，声明自己需要的 `capability`，一次调用一个 Y 事务（[REQ-AGENT §3.10.1](20-agent-canvas.md)） |
| **能力**（capability） | 不变：`flow:read` / `flow:write` / `sandbox:exec` / `llm:invoke`，由 Grant 授予（[REQ-AGENT-SANDBOX §3](22-agent-sandbox.md)） |
| **自定义技能** | [REQ-AGENT §3.10.6](20-agent-canvas.md) 规划的「画布设置里定义的技能」：成员写的指令，**只有文字，不带工具**。可以声明自己依赖哪些内置技能（§7） |
| **加载** | 把一个技能的工具交给模型、把它的提示段放进上下文 |

**技能不授予权限。** 技能只决定「把哪些工具交给模型」；每个工具执行前照样按自己的 `capability` 在网关判权，
Grant 里没有的能力，对应的技能根本不会出现（§3.2）。

## 3. 方案

### 3.1 技能的定义

```ts
interface AgentSkill {
  id: AgentSkillId               // 'canvas' | 'media-view' | 'media-exec' | 'director' | …，发布后不改（对话记录里存它）
  title: string                  // 给人看：「导演台」
  summary: string                // 一句话，放进系统提示的技能目录，模型据此判断要不要加载
  prompt: string                 // 加载后放进上下文的说明段（用法、规则、限额）
  tools(ctx: SkillContext): CanvasTool[]   // 工具定义；runner 和服务端从同一份构造（§3.5）
  requires: AgentCapability[]    // 全部工具所需能力的并集；不给 offeredWith 时，Grant 里缺任何一项，这个技能就不提供
  offeredWith?: AgentCapability[] // 提供的门槛（⊆ requires）：有这几项就提供，缺的能力对应的工具在网关逐个判权时被拒（canvas 只要 flow:read）
  available?(env: SkillAvailability): boolean   // 判断提不提供，此时还没打开画布：Grant 能力、部署条件（看图 / 对象存储 / 沙箱执行）
  workdirFiles?(ctx): Promise<Record<string, string>>   // 服务端钩子：提供了这个技能时往 runner 工作目录写的文件（如 canvas.json）
  activation: 'always' | 'auto' | 'on-demand'
  activatesFor?: { nodeTypes?: string[] }  // activation = 'auto' 时，什么情况下一轮开始就自动加载
}
```

- 每个工具仍然各自声明 `capability`。技能的 `requires` 是它全部工具所需能力的并集，和 `offeredWith` 一起**只用来判断提不提供**，不代替逐个工具的判权。
- 工具名在所有技能里全局唯一，一个工具只属于一个技能。
- **agent 的循环一律在沙箱里跑**（生产 `oci`，本地开发 `process` 弱隔离，[REQ-AGENT-SANDBOX §7](22-agent-sandbox.md)），所有技能都一样。
  技能之间的区别不在「有没有沙箱」，而在工具的执行位置，以及要不要在沙箱里起子进程、执行代码（`sandbox:exec`）。
- 执行位置是工具自己的属性：`gateway`（runner 只转发调用，由服务端执行：读写 Y.Doc、只走 `flow-ops`）或 `runner`（在 runner 的工作目录里起子进程执行，如 ffmpeg 和场景脚本，必须要求 `sandbox:exec`）。
  `runner` 工具的风险随驱动的隔离强度变化：`process` 驱动下子进程直接跑在宿主机上，身份就是启动服务的用户，
  所以执行**模型写的代码**的工具（场景脚本）在 `process` 驱动下还要额外显式开启（§8）。
  `runner` 工具在服务端只留定义（给事件里那句 `describe`），网关拒绝代它执行，这是现有媒体工具的规则（`.claude/rules/agent.md`），推广到所有技能。

### 3.2 每一轮的技能集合

一轮开始时，服务端按以下顺序算出这一轮**提供**哪些技能、**一开始就加载**哪些：

1. **提供** = 注册表里 `requires` 全在 Grant 里、并且 `available` 为真的技能。不提供的技能对模型完全不可见，目录里也没有。
2. **一开始就加载**：
   - `activation: 'always'` 的技能（`canvas`）；
   - 命中 `activatesFor` 的 `auto` 技能：用户这条消息 `@` 提及了它声明的节点类型的节点
     （从导演台里发起的新会话自动带上导演台节点的提及，[REQ-AGENT](20-agent-canvas.md) §3.10.9）；
   - 这个会话之前加载过的技能（§3.4）。
3. 其余提供了但没加载的技能进系统提示末尾的**技能目录**（`id` + `summary`），模型需要时调 `load_skill` 加载。

### 3.3 按需加载：`load_skill`

pi 的 `Agent` 在每次 `prompt()` / `continue()` 开始时对 `state.tools` 拍一次快照，一轮循环中途改工具列表不生效。
所以加载要借 pi 提前结束这一轮循环的钩子：

1. 模型调 `load_skill({ id })`。它是网关工具（`flow:read`），由服务端判断：这个技能在不在本轮的提供集合里、是不是已经加载过、本轮加载次数有没有超限。
   通过后服务端把它记进本轮的已加载集合，返回这个技能的 `prompt` 和工具名单，并带上 `terminate: true`。
2. **`load_skill` 必须单独成批**。pi 只在一批工具结果**全部**带 `terminate` 时才提前结束，所以 runner 在 `beforeToolCall` 里检查这条 assistant 消息：
   同一批里还有别的工具调用，就拦下 `load_skill`，告诉模型「请单独调用 load_skill」。系统提示里也写明这一条。
3. 循环结束、`agent.prompt()` 返回后，runner 发现这一轮有新加载的技能，就把它们的工具代理并入 `agent.state.tools`，然后 `agent.continue()`。
   模型的下一次请求带上了新工具，接着做事。
4. 每轮最多加载 3 次（`limits.maxSkillLoads`），超了 `load_skill` 返回错误，防止模型反复加载。

其它约束：

- **网关只执行已加载技能里的工具**。runner 不可信，可能调本轮没加载的工具名，网关一律拒绝（「工具未加载」）。这和能力判权是两道检查，不合并。
- **提示段放在工具结果里，不改系统提示**：系统提示一轮之内不变。加载结果（`load_skill` 的工具结果）本身就是一段说明文字，跟着对话历史走。
- **工具列表变化会让模型侧的提示缓存失效一次**（工具定义在请求最前面）。一轮通常只加载一两次，可以接受；常用组合可以靠 §3.2 的自动加载提前带上。

### 3.4 跨轮：技能跟着会话走

- 会话记录这个会话加载过的技能（`skills: AgentSkillId[]`，只增不减）。下一轮开始时预先加载，否则历史里的工具调用在新一轮找不到对应工具，模型会困惑。
- 预加载照样过 §3.2 第 1 步：Grant 或部署条件变了（比如关掉了 `AGENT_SANDBOX_EXEC`），不提供的技能就不加载。
  这一轮的系统提示里说明「以下技能本轮不可用：…」。
- 删除会话时一并删掉这份记录；别人只读查看会话时能看到它加载过哪些技能。

### 3.5 代码组织

- `packages/agent/src/skills/`：`registry.ts`（`defineSkill`、注册表、§3.2 的集合计算）和每个技能一个目录（`canvas/`、`media/`、`director/`）。
  现在的 `tools.ts` 按技能拆开，工具实现不变。
- **runner 和服务端从同一份注册表构造工具**：服务端造真实工具，runner 照旧用 `NO_CANVAS` 造定义再包成代理（现在 `createCanvasTools({ canvas: NO_CANVAS })` 的做法）。
  技能模块属于两侧共用的代码，**不能 import 服务端模块**（`session` / `gateway` / `store` / `canvas-changes`），规则同 `agent.md`。
- `RunnerInput` 从 `tools: string[]` 改成按技能的结构，另带会话绑定的节点 `boundNode`（两侧构造工具用同一个上下文）。runner 协议版本因此升到 2，改了 runner 侧要重建沙箱镜像。
  取消节点范围会话后 `boundNode` 去掉，协议版本再升一次。
  runner 按注册表展开工具名单，`load_skill` 的结果里有新加载的工具名单。
- 系统提示拆成「平台基础段（安全与通用规则，不可覆盖）+ 每个已加载技能的 `prompt` + 技能目录」。
  `SYSTEM_PROMPT` 里属于画布工具用法的那部分挪进 `canvas` 技能的 `prompt`。
- 契约：`@shadecn/shared/agent` 增加 `AgentSkillId`（`string`，不是字面量联合：测试要注册任意技能）、会话视图上的 `skills`（`{ id, title }[]`，前端不 import 注册表）与 `nodeId`，以及 CUSTOM 事件 `agent.skill-loaded`（§3.6）。
- 工具实现仍在 `tools.ts`，按技能导出工厂（`createCanvasBaseTools` / `createViewMediaTool`），技能目录调用它们。
- 重复加载已加载的技能不算错误，不计次数、也不结束这一批；`load_skill` 本身计入每轮工具调用上限，在网关判 `flow:read`。

### 3.6 界面

- 对话流里，每次加载显示一行「已加载：导演台」（由 `agent.skill-loaded` 事件驱动，刷新、接回补发、只读旁观看到的一样）。
  一轮开始时自动加载的技能不逐条刷屏，输入框上方列出当前已加载的技能（标题里不显示；新会话的第一轮里，这一栏要到下次打开会话才包含自动加载的技能 —— 已知缺口）。
- 被拒的 `load_skill`（不提供、同批混用、超次数）在界面上看不到，只在工具调用日志里。
- `load_skill` 本身不作为普通工具调用条目展示，只显示上面那一行。

## 4. 首批技能

| id | 标题 | 工具 | requires | 可用条件 | activation |
|---|---|---|---|---|---|
| `canvas` | 画布 | 读 `read_canvas`、`get_node`、`check_connection`；写 `add_node`、`update_node`、`duplicate_node`、`connect`、`delete_elements`、`move_nodes`、`resize_node`、`group_nodes`、`ungroup`、`auto_layout` | `flow:read`、`flow:write`、`flow:delete` | — | `always` |
| `media-view` | 查看素材 | `view_node_media` | `flow:read` | 模型支持图片输入，并且配了对象存储（[REQ-AGENT §3.10.7](20-agent-canvas.md)） | `on-demand` |
| `media-exec` | 媒体处理 | `run_media_command`（runner） | `sandbox:exec` | `AGENT_SANDBOX_EXEC=1` | `on-demand` |
| `director` | 导演台：写 + 量 | 原子操作 `get_director_scene`、`add_objects`、`transform_objects`、`place_object`、`align_objects`、`distribute_objects`、`aim_camera`、`update_objects`、`set_director_settings`、`set_keyframes`、`animate_motion`、`delete_director_elements`；测量 `measure_objects`、`measure_distance`、`check_scene`、`camera_view`（都在网关执行） | `flow:read`、`flow:write`、`flow:delete` | — | `auto`：`nodeTypes: ['director']` |
| `director-view` | 导演台：看 | `render_view`（网关调渲染服务） | `flow:read` | 配了渲染服务，并且模型支持图片输入 | `auto`：同上 |
| `director-script` | 导演台：脚本 | `run_scene_script`（runner，产出操作列表交网关执行） | `flow:read`、`flow:write`、`sandbox:exec` | `AGENT_SANDBOX_EXEC=1` | `on-demand` |

- `canvas` 是基础技能，不做按需加载：几乎每一轮都要读写画布，按需加载只会多一次往返。
  原先拆成只读的 `canvas` 和写入的 `canvas-edit`，是为了节点范围会话的画布只读；节点范围会话取消后（REQ-AGENT §3.10.9）合成一个。
  会话记住的技能（§3.4）里旧的 `canvas-edit` 按 `canvas` 读。
- 每个工具仍各自声明 `capability`：Grant 里缺 `flow:write` / `flow:delete` 时，`canvas` 照样提供（只要有 `flow:read`），写工具在网关逐个判权时被拒。
- 导演台三个技能的工具、写 → 量 → 看的闭环、渲染服务与脚本的安全要求见 [REQ-DIRECTOR](07-director-console.md) §7.3。
  拆成三个是因为它们的可用条件不同：写 + 量都是网关工具，不需要 `sandbox:exec`，任何部署都有；看要渲染服务和能看图的模型；
  脚本要在沙箱里执行模型写的代码，需要 `sandbox:exec`。
  **不让模型直接写整块场景 JSON**，所有写入都走原子操作（脚本也只是批量产生原子操作）。
- 原来写在 `session.ts` 里的条件（看图、媒体工具、`canvas.json` 写进工作目录）挪进各自技能的 `available` 和初始化钩子。

## 5. 功能需求

| 编号 | 需求 |
|---|---|
| S1 | 工具按内置技能注册；每轮只把已加载技能的工具交给模型 |
| S2 | 技能的提供由 Grant 能力与部署条件共同决定；不提供的技能对模型不可见 |
| S3 | `always` 技能每轮自动加载；`auto` 技能在提及对应类型的节点时自动加载；其余由模型调 `load_skill` 加载 |
| S4 | `load_skill` 单独成批，加载后新工具在同一轮里可用；每轮加载次数有上限 |
| S5 | 网关拒绝执行本轮没加载的技能里的工具 |
| S6 | 会话记住加载过的技能，下一轮预加载（仍受 S2 约束） |
| S7 | 对话里显示技能加载，输入框上方列出已加载的技能 |

## 6. 验收标准

1. 普通画布会话：第一次模型请求里只有 `canvas` 的 13 个工具和 `load_skill`，系统提示的技能目录里有其它提供了的技能。
2. 消息里提及一个导演台节点（含从导演台里发起、自动带上提及的新会话）：第一次模型请求里就有 `director` 的工具，也有 `canvas` 的全部工具。
3. 模型调 `load_skill({ id: 'director' })` 后，同一轮的下一次请求带上导演台工具，模型能调用它们；对话里出现「已加载：导演台」。
4. 同一批里同时调 `load_skill` 和别的工具：`load_skill` 被拦下并返回原因，别的工具照常执行。
5. 伪造的 runner 直接请求网关执行一个没加载的技能里的工具：网关拒绝，画布不变。
6. Grant 里没有 `sandbox:exec`：技能目录里没有 `media-exec` 和 `director-script`，`director` 照常可用。
7. 下一轮继续同一个会话：上一轮加载过的技能在第一次请求里就在。
8. 一轮加载超过 3 次：第 4 次 `load_skill` 返回错误。

## 7. 与自定义技能（REQ-AGENT §3.10.6）的关系

- 自定义技能是成员写的**指令**，内置技能是平台提供的**工具集**。两者不合并成一种东西：自定义技能永远不能带代码或新增工具。
- 自定义技能可以声明 `requires: AgentSkillId[]`。模型 `load_skill` 一个自定义技能时，它依赖的内置技能一起加载（同样受 S2 约束，缺了就说明哪项不可用）。
- 技能目录里两种分开列：内置技能在前，自定义技能在后并标明「成员编写」。提示词层级不变：平台规则 > 自定义技能 > 用户人设 > 当前会话。

## 8. 待确认

1. ~~没开沙箱执行时导演台怎么办~~ —— **已定**：拆成 `director` / `director-view` / `director-script` 三个技能，写 + 量不需要 `sandbox:exec`（§4）。
2. ~~`canvas` 要不要拆~~ —— **已定**：不拆，读写合成一个 `canvas`（节点范围会话取消，REQ-AGENT §3.10.9；原先拆成 `canvas` / `canvas-edit`）；布局类暂不再拆。
3. ~~技能能不能卸载~~ —— **已定**：不能，只增不减。
4. ~~每轮加载上限~~ —— **已定**：3 次。
5. 执行模型写的代码的工具（`run_scene_script`）在 `process` 驱动下怎么开：沿用 `AGENT_SANDBOX_EXEC=1` 就算开启，
   还是另设一个开关（如 `AGENT_SANDBOX_ALLOW_CODE_ON_HOST=1`），默认关闭。倾向另设开关：ffmpeg 跑的是固定程序，脚本跑的是任意代码，两者风险不同。
