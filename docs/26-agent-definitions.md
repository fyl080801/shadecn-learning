# REQ-AGENT-DEF Agent 定义与同一沙箱内的多 agent 协作

> 状态：**已实现**（P0～P5 全部完成）。原来是一个隐含的「画布 agent」加上从属于它的「子 agent」（[REQ-AGENT](20-agent-canvas.md) §3.10.11）；
> 本文把它改成**对等的 agent 定义 + 同一轮里的任务**，分期见 §4。P2 起定义读自 `packages/agent/agents/*.md`（仓库里目前只有 `canvas.md`），工具白名单在服务端生效；
> P3 起发起任务用 `run_agent({ agent, task, nodeIds? })`，被调用的 agent 用它自己的定义（正文、白名单 —— runner 里也按它滤 —— 、模型键），
> 调用深度有上限（默认 1，深度大于 1 也可用，嵌套的任务条目挂在发起它的任务条目里），runner 协议第 8 版。
> P4 起模型表 = `default`（环境变量）+ 模型表文件里的项（§3.4），每个 agent 按自己定义的 `model` 调上游、算费用与看图能力，runner 协议不变。
> P5 起有文字技能（§3.8）：`packages/agent/skills/` 里的 pi `SKILL.md`（仓库里目前只有说明目录的 `README.md`，没有技能），提供给每个 agent，按需加载时连同依赖的内置技能一起加载；
> 一次加载可能带进几个内置技能，`load_skill` 交给 runner 的结果因此改成 `loadedSkills` 数组，runner 协议第 9 版（沙箱镜像要重建）。
>
> 前置：[REQ-AGENT](20-agent-canvas.md)（画布 agent、占用、§3.10.11 的协作规则）、
> [REQ-AGENT-SANDBOX](22-agent-sandbox.md)（runner / 网关、§4.3 服务端调模型与权威 transcript）、
> [REQ-AGENT-SKILL](23-agent-skills.md)（技能注册表、`load_skill`）。

## 1. 目标与背景

画布之后会有多种 agent：用不同的模型、给不同的工具、按不同的方式干活（先规划再动手、只读审查、专做导演台……）。
现在的实现里没有「agent 定义」这一层，只有一个写在代码里的画布 agent；它把一件事交给另一个 agent 时，对方被叫做「子 agent」，
和它用同一个模型、同一套技能，只是少了派发、多了 `request_confirmation`。「主」和「子」看起来像两种类型，其实是两件事揉在了一起：

- **agent 定义**（它是谁）：系统提示、模型、能用哪些工具 —— 现在不存在；
- **调用关系**（谁调起了它）：用户发起的这一轮，还是另一个 agent 交给它的一件事 —— 现在被写成了「父 / 子」类型。

本需求把两者分开：

1. **每个 agent 都是一份定义，只有一种格式**，沿用 pi 的 agent 配置（`agents/*.md`，§3.1）；没有「子 agent」这种类型。
2. 一个 agent 把一件事交给另一个 agent，就是在**同一轮、同一个沙箱**里开一个**任务**：对方作为独立的 pi `Agent` 跑完，结果交回。
   这是协作，不是从属；调用方和被调用方的差别只在**这一轮里的角色**（§3.6），由服务端按调用关系判，不写进定义。
3. agent 定义与模型都由**服务端配置**、随代码发布；用户可扩展的口先开给**技能**（pi 的 `SKILL.md`，§3.8）。

**不做**：远程 agent / A2A 协议对接（外部服务以后需要时另立需求）；用户自定义 agent；见 §7。

## 2. 名词

| 名词 | 含义 |
|---|---|
| **agent 定义**（`AgentConfig`） | 一个 `.md` 文件：frontmatter `name` / `description` / `tools` / `model` + 正文（系统提示）。字段与 pi 的 agent 配置一一对应（§3.1） |
| **任务**（task） | 一个 agent 在这一轮里交给另一个 agent 的一件事：`run_agent` 的一次调用。在会话里显示成可展开的任务条目 |
| **入口 agent** | 这一轮里直接和用户对话的那个 agent。目前固定是 `canvas` |
| **调用方 / 被调用的 agent** | 发起任务的 agent / 执行任务的 agent。同一个定义既可以是入口，也可以被调用 |
| **调用深度** | 入口 agent 深度 0，它调用的 agent 深度 1，依此类推。服务端按上限判（§3.5） |
| **模型表** | 服务端配置的一组模型，每项一个 key；agent 定义的 `model` 引用其中一项（§3.4） |
| **文字技能** | 用 pi `SKILL.md` 格式写的技能：只有指令、不带工具，可依赖内置技能（§3.8）。即 REQ-AGENT-SKILL 里的「自定义技能」 |

## 3. 方案

### 3.1 agent 定义：沿用 pi 的格式

格式就是 pi 的 agent 配置（`@earendil-works/pi-coding-agent` 1.4 的 subagent 示例，`examples/extensions/subagent/agents/*.md`）：

```md
---
name: canvas
description: 画布助手：读写节点、整理布局、搭导演台场景
tools: read_canvas, get_node, add_node, update_node, run_agent   # 可省略 = 全部
model: default                                          # 可省略 = default
---

（正文：这个 agent 的系统提示 —— 它是谁、怎么干活）
```

- **不另造定义类型**。pi 没有从包里导出这个类型（它在示例目录里），`pi-coding-agent` 是命令行包、依赖很重，也不引入；
  代码里照抄同名同字段的 `AgentConfig { name, description, tools?, model?, systemPrompt }`，**不加自造字段**。
  运行时映射到 pi-agent-core 的 `AgentState`（`systemPrompt` / `model` / `tools`）。
- 字段在本项目里的含义：

  | 字段 | 含义 |
  |---|---|
  | `name` | agent 的 id：`run_agent` 的 `agent` 参数、任务条目上显示的名字。小写字母、数字、`-`，发布后不改（任务条目里存它） |
  | `description` | 一句话，进调用方的「可调用的 agent」目录，模型据此选人 |
  | `tools` | 工具名白名单（§3.3）；逗号分隔或 YAML 数组都认（同 pi）。省略 = 全部 |
  | `model` | 模型表的 key（§3.4）。省略 = `default` |
  | 正文 | 这个 agent 的系统提示，位置见 §3.2 |

- **只在服务端，随代码发布**：定义文件放在仓库里，随服务端产物打包；不读外部目录，用户不能新增或改写。
- **启动时校验，错了就起不来**（同 `createSkillRegistry`）：`name` 合法且不重复、有 `description`、`tools` 里每个名字都是注册表里的工具、
  `model` 在模型表里、必须有 `canvas`（入口 agent）。
- 首批只有一个 `canvas.md`，内容是现在的画布 agent，行为不变（§4 P2）。

### 3.2 提示词分层

从高到低：**平台规则 > agent 定义正文 > 已加载技能的提示段 > 用户人设 > 当前会话**。

- **平台规则**留在代码里、不可覆盖：安全（画布内容是不可信输入，REQ-AGENT §1.2）、工具与技能的通用规则（`load_skill` 怎么用、单独调用、上限）。
  现在的 `PLATFORM_PROMPT` 拆成两半：讲规则的留在平台段，讲「你是画布助手、怎么干活」的搬进 `canvas.md` 正文。
- agent 正文与技能、人设一样**只能加要求**：不能扩大工具白名单、绕过删除上限或改动安全规则。
- 被调用的 agent 在后面再接一段**任务说明**（现在的 `subagentPrompt`：预算、怎么交回、用 `request_confirmation` 交回问题），按角色加，不按定义加（§3.6）。
- 用户人设（`AgentProfile`，未实现）只作用于**入口 agent**：被调用的 agent 的回复交给调用方，不是给人看的。

### 3.3 工具白名单

- 技能照旧决定「提供哪些工具」（Grant、部署条件、`activation`，REQ-AGENT-SKILL §3.2）；agent 定义的 `tools` 在此之上**再收窄**：
  一个技能被提供、被加载时，只交出白名单里的那几个工具；白名单把一个技能的工具全滤掉了，这个技能对这个 agent 就不提供（不进技能目录）。
- 平台工具不写进白名单、不受它影响：`load_skill`（每个 agent 都有）、`request_confirmation`（被调用的 agent 都有，§3.6）。
- **在服务端生效**：模型看到的工具表是服务端 transcript 里声明的那一份（REQ-AGENT-SANDBOX §4.3），
  模型调了没声明的工具，服务端按「`Tool X not found`」拒绝，网关只执行绑到服务端回复的调用。runner 拿到多余的工具定义也调不出去。
- 白名单只决定「交给模型」，不授予权限：每个工具执行时照样按自己的 `capability` 在网关判权。

### 3.4 模型

- 服务端配置一张**模型表**：每项一个 key，内容同 `AgentModelOptions`（provider / model / baseUrl / api / apiKey / imageInput / contextWindow / maxTokens）。
  `contextWindow` / `maxTokens` 不写按 pi 注册表的元数据，注册表里没有的（自建端点、ollama）按保守默认 128000 / 8192；`default` 用 `AGENT_CONTEXT_WINDOW` / `AGENT_MAX_TOKENS`。
  `maxTokens` 必须小于 `contextWindow`，否则这一项不可用（同解析不出来的模型）。
  - **`default`** 就是 `AGENT_PROVIDER` / `AGENT_MODEL` / `AGENT_BASE_URL` / `AGENT_API` / `AGENT_API_KEY` / `AGENT_IMAGE_INPUT`（行为不变，含没给 key 时按提供方自己的环境变量退回）；
  - **其余的项**在一个 JSON 文件里，默认 `<DATA_DIR>/agent-models.json`（不在仓库里），`AGENT_MODELS_FILE` 可换路径（相对路径按应用根目录算；k8s 上可以挂一个 ConfigMap 文件）。
    文件不存在 = 模型表只有 `default`：

    ```json
    { "fast":   { "provider": "anthropic", "model": "claude-haiku-4-5", "apiKey": "$AGENT_FAST_KEY" },
      "vision": { "provider": "my-proxy", "model": "qwen-vl", "baseUrl": "https://llm.internal/v1",
                  "api": "openai-completions", "apiKey": "$AGENT_VISION_KEY", "imageInput": true } }
    ```

  - key 同 agent 名（小写字母开头，小写字母、数字、`-`）；文件里不能有 `default`；只认上面六个字段。
  - **`apiKey` 只能写成 `"$环境变量名"`**，写明文启动失败 —— **密钥只在服务端的环境变量里**，不进模型表文件、不进定义文件、不进沙箱。
    不写 `apiKey` = 同 `default` 的退回规则（按提供方自己的环境变量）；写了引用而那个变量没设 = 这一项不可用（不再退回）。
- **启动时校验**：文件不是合法 JSON、key 不合法、写了 `default`、不认识的字段、类型不对、`apiKey` 写了明文、定义的 `model` 引用了表里没有的 key
  → 服务端起不来（同定义文件，§3.1）。一项**能读懂但用不了**（引用的环境变量没设、pi 的注册表里没有、线协议服务端调不了）不是启动错误：启动时打一行警告，到用时才报（见本节最后一条）。
- 每个 agent 用自己定义里的模型：服务端按 agent 调上游（网关的模型路由本来就带 `agentId`），runner 只拿到它那一份模型的元数据（`RunnerModel`，`streamProxy` 要用）。
- 跟着模型走的东西按 **agent 自己的模型**算：看不看得了图（`media-view` 只给吃图片的模型；这一轮提供的是各 agent 的并，每个 agent 只拿到自己那份）、
  上下文超长判断、历史裁剪的 token 预算（这两样只有入口 agent 有：被调用的 agent 的上下文不跨轮、不落库，没有历史可裁）。
- **用量**：token 照旧全轮合计；费用按每次请求**它自己的模型**的价格算再相加，这一轮里**只要有一次请求的模型没有定价，费用记 `null`**
  （不报一个偏低的数）。`agent_run.model` 记入口 agent 的模型；会话上显示的模型也是入口 agent 的。
- 一个模型表项解析不出来（引用的环境变量没设、注册表里没有、线协议不支持服务端调用）：入口 agent 的模型不可用 → agent 未启用、这一轮不开始
  （同没配模型；原因写明是哪一项）；被调用的 agent 的不可用 → 那次 `run_agent` 返回错误（「agent X 的模型「k」不可用，没有发起任务：原因」），调用方自己决定怎么办。
  `run_agent` 的可调用目录照旧列出全部定义（不因模型不可用而变）。

### 3.5 调用：`run_agent`

取代现在的 `delegate_task`，参数名沿用 pi subagent 示例的 `{ agent, task }`：

```ts
run_agent({
  agent: string,       // 必填：已配置的 agent 的 name（定义里的 enum）
  task: string,        // 任务说明，要自足（被调用的 agent 看不到调用方的对话）
  nodeIds?: string[],  // 它要处理的节点，变成它第一条消息里的提及（同现在）
})
```

- **`agent` 必填**：调同一个定义也要写出来（`canvas` 调 `canvas` 就是现在的行为）。工具描述里列出可调用的 agent（`name` + `description`），同技能目录。
- **谁能调用**：定义的工具白名单里有 `run_agent`（省略 `tools` 即有），且**调用深度没到上限**。到上限的 agent 工具表里**没有** `run_agent`（不只是调用时拒绝），
  服务端也拒绝它发起的任务。**上限默认 1**：入口 agent 能调用，被调用的 agent 不能再调用 —— 和现在「只有一层」行为相同，但它是一个配置上限，不是类型规则。
  上限调大时被调用的 agent 也能再调用，它发起的任务同样是一个任务条目，**嵌在发起它的那个任务条目里**显示（在它那条 `run_agent` 的位置）。
  同时 / 累计上限、工具调用次数按全轮各层合计；被调用的 agent 的任务说明段会说明它还能不能再调用。
- **并行、数量、预算、时长、停止、撤回、失败处理、结果怎么交回**：都不变，见 REQ-AGENT §3.10.11
  （同一批全是 `run_agent` 才并行；同时 3 个 / 一轮累计 10 个；步数各算、工具调用次数与删除上限全轮共用；等任务时暂停单轮计时、总时长上限照算；
  随这一轮一起停；只交回最终回复（限 2000 字）和改过的节点）。
- 链式（后一步拿前一步的输出，pi 的 `chain` 模式）不做成工具：调用方拿到结果后自己再发下一个任务。

### 3.6 角色，不是类型

同一个定义在一轮里可以是入口，也可以被调用；所有差别都按角色由服务端判：

| 规则 | 入口 agent | 被调用的 agent |
|---|---|---|
| 和用户对话、上下文跨轮保存 | 是（会话的 `llmMessages`） | 否：transcript 在任务开始时建、交回后丢，不落库 |
| 别人改动的通知（REQ-AGENT §3.10.2） | 插给它 | 不插，靠「改过」检查发现 |
| 需要确认时 | 停下这一轮、问用户 | 调 `request_confirmation({ question })` 交回调用方（必须单独调用，调了就结束） |
| 提示词 | 平台 + 正文 + 技能 + 人设 | 平台 + 正文 + 技能 + 任务说明段（§3.2） |
| 能不能发起任务 | 看白名单与深度上限（§3.5） | 同左 |
| 节点占用、「改过」检查、步数 | 按 agent 各记（REQ-AGENT §3.10.8、§3.10.11），入口 agent 和被调用的 agent 之间、被调用的 agent 彼此之间都互相算「别人」 | 同左 |

- 调用方把自己占用的节点作为 `nodeIds` 交出去时，占用原子地转给被调用的 agent；它结束时释放，不还给调用方（同现在）。
- 被调用的 agent 用的模型、工具白名单、正文都来自**它自己的定义**，不继承调用方的；Grant、令牌、沙箱、会话、任务列表项是这一轮的，和调用方共用。
- 调用方等它的时候，单轮时长照旧暂停（REQ-AGENT §3.10.11「时长」）：有任务在跑就等于入口 agent 在等（嵌套时下层的任务只在上层还在等它时才在跑）。

### 3.7 入口 agent

- 目前固定是 `canvas`：会话不能选别的 agent 做入口。
- 以后要让会话选入口 agent（例如快捷会话用一个只读的审查 agent），只需在会话上记一个定义名；本期不做（§7）。

### 3.8 文字技能：pi 的 `SKILL.md`

用户可扩展的口先开在技能上。格式用 pi / Agent Skills 标准的 `SKILL.md`：

```md
---
name: storyboard-review
description: 按分镜规范检查导演台场景，列出问题
requires: [director]        # 可省略：依赖的内置技能 id
---

（正文：指令）
```

- 只有指令，**永远不带代码、不新增工具**（REQ-AGENT-SKILL §7）。`requires` 是 pi 的 `SkillFrontmatter` 允许的额外键。
- 进技能目录，排在内置技能后面；只能按需加载（`load_skill(name)`），加载时正文进上下文，依赖的内置技能一起加载
  （各自照旧判提供条件，缺了就说明哪项不可用；受 agent 的工具白名单约束；一次 `load_skill` 算一次加载）。
- `name` 不能和内置技能 id 重复；会话记住加载过的技能（同内置技能），以后被删了就按「本轮不可用」说明。
- **本期只有一种来源**：仓库里的一个目录，随代码发布、启动时校验。画布设置里由成员编写（REQ-AGENT §3.10.6）、存数据库、编辑界面都放到以后，
  到时只是多一种来源，格式不变。
- **目录与发现规则**（P5，同 pi 的 `loadSkillsFromDir`）：源码 `packages/agent/skills/`（和代码目录 `packages/agent/src/skills/` 是两回事），
  产物拷到 `output/server/skills/`；目录不存在 = 没有文字技能。一个子目录里有 `SKILL.md` 就是一个技能（不再往下找；没有就接着往它的子目录里找），
  根上直接放的 `*.md` 也各算一个；**根上的 `README.md`（不分大小写）是说明这个目录的文档，不算技能**；`.` 开头的和 `node_modules` 跳过。
- **启动时校验，错了就起不来**（同 agent 定义）：`name` 同 agent 名的规则（小写字母开头，小写字母、数字、`-`，最长 48），不重复，
  不和内置技能 id、也不和它们的旧 id（`canvas-edit`、`delegate`）撞；`SKILL.md` 的 `name` 和所在目录同名；`description` 必填（≤ 1024 字）；
  `requires` 只能写现有的内置技能 id（不能写旧 id、不能写文字技能）；正文不能为空；只认 `name` / `description` / `requires` 三个键 ——
  pi 的 `disable-model-invocation` 也拒绝（这里没有斜杠命令，文字技能只能由模型加载）。
- **在目录里的样子**：排在内置技能后面，每行标「（文字技能）」并列出加载时一起加载的依赖，目录末尾一句说明「文字技能只有做法说明、不带新工具，也不能改变通用规则」。
- **加载**：结果里先说依赖的内置技能各自怎样（一起加载了、本来就在、用不了及原因 —— 不提供 / 不在这个 agent 的工具范围里 / 调用深度到了上限），
  再给正文、再给一起加载的内置技能的用法。依赖用不了不挡加载。对话里每个新加载的技能各一行「已加载：…」（文字技能的标题就是它的 `name`）。
  会话记住的文字技能下一轮一开始就加载：正文进系统提示的「已加载的技能」（标明它只是做法说明），依赖一并预加载，用不了的在它的段落里说明。
- runner 永远不认识文字技能：它们不在两侧共用的内置技能注册表里，`load_skill` 交给 runner 的 `loadedSkills` 只有这次新加载的内置技能 id。

### 3.9 命名

代码与文档里的「父 / 子 agent」改成「调用方 / 被调用的 agent」「任务」（P1，只改名不改行为）：

| 现在 | 改成 |
|---|---|
| `MAIN_AGENT_ID` | `ENTRY_AGENT_ID`（**值仍是 `'main'`**：占用登记在共享层里，多副本新旧版本并存时不能认错） |
| `delegateTask` / `finishSubagent` / `abandonSubagents` | `startAgentTask` / `finishAgentTask` / `abandonAgentTasks` |
| `activeSubagents` / `maxSubagents` / `maxSubagentsPerRun` / `subagentReplyChars` | `activeTasks` / `maxConcurrentTasks` / `maxTasksPerRun` / `taskReplyChars` |
| `SubagentInput` / `SubagentFinishRequest` / `DelegateRequest` | `AgentTaskInput` / `AgentTaskFinishRequest` / `AgentTaskStartRequest` |
| `subagentPrompt` / `subagentBrief` | `taskPrompt` / `taskBrief` |
| 技能 `delegate`、工具 `delegate_task` | 技能 `agents`、工具 `run_agent`（P3，随协议升级） |
| 网关路由 `/agent/delegate`、`/agent/finish` | `/agent/task/start`、`/agent/task/finish`（P3，随协议升级） |

**不改**：对外的事件与落库形状里的 `subtask`（CUSTOM `agent.subtask` / `agent.subtask-update`、消息上的 `subtasks`、`AgentSubtaskView`）——
它指的是会话里的任务条目，概念本来就对，改它要做旧数据兼容。`AgentSubtaskView` 只**新增** `agent` 字段（P3）；旧条目没有这个字段，按 `canvas` 显示。
会话里已经存着的 `delegate_task` 调用（`llmMessages`、工具调用日志、assistant 消息的 `toolCalls`）原样保留，不迁移：
界面照样把它画成任务条目，会话记着的技能 `delegate` 读出时换成 `agents`（不显示成「本轮不可用」）。

## 4. 分期

| 期 | 内容 | runner 协议 | 行为变化 |
|---|---|---|---|
| P0 ✅ | 文档：本文、REQ-AGENT §3.10.11 改成协作口径、REQ-AGENT-SKILL §7 | — | 无 |
| P1 ✅ | 只改名（§3.9 表里不随协议升级的那些）、规则文件同步 | 不变 | 无 |
| P2 ✅ | 读入 `agents/*.md`（只有 `canvas.md`）、启动校验、拆 `PLATFORM_PROMPT`、工具白名单在服务端生效 | 不变（系统提示与工具表第 7 版起本来就只在服务端） | 无 |
| P3 ✅ | `run_agent({ agent, task, nodeIds? })`、可调用 agent 目录、调用深度上限、按角色给 `request_confirmation`、任务条目带 `agent`、任务输入带它的 `model` | 7 → 8，重建沙箱镜像 | 能调用不同的 agent（模型仍只有 `default`） |
| P4 ✅ | 模型表（`default` + 模型表文件）、按 agent 选模型、费用与历史预算按 agent 的模型算 | 不变（P3 已带 `model`） | 不同 agent 可用不同模型 |
| P5 ✅ | 文字技能（`SKILL.md`，仓库目录一种来源） | 8 → 9（原计划不变：加载文字技能要一次并进几个内置技能，`load_skill` 结果的 `loadedSkill` 改成 `loadedSkills` 数组），重建沙箱镜像 | 能扩展技能 |

## 5. 功能需求

| 编号 | 需求 |
|---|---|
| F1 | agent 由服务端的 pi 格式定义文件描述（`name` / `description` / `tools` / `model` + 正文），只有一种格式；启动时校验，不合法就起不来 |
| F2 | 入口 agent 固定为 `canvas`；首批定义只有它，行为与现在相同 |
| F3 | agent 的工具白名单在服务端生效：模型只看到白名单内的工具，调了别的被拒；平台工具不受白名单影响；白名单不授予权限 |
| F4 | `run_agent({ agent, task, nodeIds? })` 在同一轮、同一沙箱里开一个任务，用被调用 agent 自己的定义（正文、工具、模型）执行，等它做完返回结果 |
| F5 | 调用深度有上限（默认 1）；到上限的 agent 没有 `run_agent`，服务端也拒绝它发起的任务 |
| F6 | 入口 / 被调用的差别按角色判（§3.6），不写进定义 |
| F7 | 每个 agent 用定义里的模型；看图、上下文预算按它自己的模型；一轮费用只要有一次请求的模型没定价就记 `null` |
| F8 | 任务条目显示执行它的 agent 名 |
| F9 | 文字技能用 `SKILL.md` 格式，只有指令，可依赖内置技能，按需加载 |

## 6. 验收标准

1. P1、P2 之后：现有 agent 测试全部照过，事件序列、落库内容与改动前逐帧相同。
2. 把 `canvas.md` 的 `tools` 改成只有读类工具：模型请求里只声明读类工具与 `load_skill`；伪造一次 `update_node` 调用被拒，画布没变。
3. 定义文件里 `model: missing`、`tools` 写了不存在的工具、两个文件同名、没有 `canvas.md`：服务端启动失败，日志指出哪个文件哪个字段。
4. 再配一个 `reviewer.md`（只读工具、无 `run_agent`）：让 `canvas` 「请 reviewer 检查这三个导演台」→ 会话里出现三个任务条目，标着 `reviewer`；
   `reviewer` 的模型请求用它自己的系统提示和工具表，里面没有 `run_agent`；结果交回 `canvas`。
5. 调用深度上限为 1 时：被调用的 agent 的工具表里没有 `run_agent`；伪造它发起任务的请求被网关拒绝。
6. `reviewer` 配了另一个模型（P4）：它的请求打到那个模型；这一轮的 token 是两者合计；其中一个模型没有价格时 `costMicroUsd` 为 `null`。
7. 仓库里加一个 `SKILL.md`（P5）：它出现在技能目录末尾；`load_skill` 它之后正文进上下文、`requires` 的内置技能一起加载；它不能带来新工具。

## 7. 本期不做

- 远程 agent、A2A 协议（发现 Agent Card、`message/send`）、对接外部 agent 服务。
- 用户 / 项目自定义 agent 定义；从外部目录或数据库读定义。
- 会话选择入口 agent。
- 每个定义自己的步数、回复长度等上限（全部 agent 共用这一轮的上限）。
- pi 的链式（`chain`）与 `{previous}` 占位符。
- 文字技能的成员编辑界面与数据库来源（REQ-AGENT §3.10.6）。

## 8. 待确认

1. ~~调用深度~~ —— **已定**：上限默认 1（行为同现在），作为配置上限而不是类型规则。
2. ~~`run_agent` 的 `agent` 参数要不要必填~~ —— **已定**：必填。
3. ~~定义文件放在哪~~ —— **已定**：只随仓库打包，不读外部目录。
4. ~~混用模型时的费用~~ —— **已定**：只要有一次请求的模型没有定价，这一轮费用记 `null`。
5. ~~模型表除 `default` 以外的项怎么配置~~ —— **已定**（P4）：一个 JSON 文件（默认 `<DATA_DIR>/agent-models.json`，`AGENT_MODELS_FILE` 可换），
   密钥只能写成 `"$环境变量名"` 引用，`default` 仍来自 `AGENT_*` 环境变量（§3.4）。
6. ~~定义文件与文字技能在仓库里的目录~~ —— **已定**：agent 定义（P2）`packages/agent/agents/`，产物里拷到 `output/server/agents/`；
   文字技能（P5）`packages/agent/skills/`，产物里拷到 `output/server/skills/`，根上的 `README.md` 不算技能（§3.8）。
