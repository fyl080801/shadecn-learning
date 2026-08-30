/**
 * GalStory 控制台的前端类型。
 *
 * **这是 gal_story HTTP 面视图模型的镜像**（`gal_story/server/models.py`，那一层
 * `alias_generator=to_camel`，所以线上格式一律 camelCase）。两边是两个工程，故类型各写一份，
 * **改一边记得同步另一边** —— 与 `src/types/flow.ts` ↔ `server/store/flow-types.ts` 同一条做法。
 *
 * 三条边界写在类型上：
 *
 * 1. **故事 ≠ 存档**。故事是作者态的模板目录，存档是 `<storage>/<story>/<save-id>/`，
 *    里面**冻结了模板的一份整副本** —— 改模板不影响进行中的存档。
 * 2. **选单 ≠ 详情**。`StorySummary` 是玩家面的选故事口，除 `title` 外一个字都不给
 *    （引擎里 `StorySpec` 的 docstring 写着「仅导演可见」，里面有 `core_conflict`/`ending`）；
 *    `StoryDetail` 是作者面，给的 `goal`/`endWhen`/私有条目数对玩家全是剧透。
 * 3. **`BindingView` 的 `connectionId`/`source`/`timeBudgetS` 由引擎算，前端不许自己再算**。
 *    三层优先级的唯一声明处是 `AgentClients.binding_of`，重算一份就是同一个判据两处声明。
 */

// ── 体检 ────────────────────────────────────────────────────────────────────

/**
 * 词表与引擎的 `knowledge.pages.LintIssue` 一致。
 * - `error` 会让 `gal-story lint` 退出码变 1（挂得住 CI）
 * - `warn` 是「配了但到不了 / 少做了一件事」，不阻断
 * - `info` 是「这是受支持的降级，只是成本结构变了」
 */
export type LintLevel = "error" | "warn" | "info"

export interface LintIssue {
  code: string
  level: LintLevel
  /** 出问题的那个东西（agent 名 / 角色 id / 场景 id）；说不出具体位置时是空串 */
  where: string
  message: string
}

// ── 故事 ────────────────────────────────────────────────────────────────────

/** 故事选单里的一项。**刻意只有这么几个字段**，见模块头第 2 条。 */
export interface StorySummary {
  /** 目录名，也是 `gal-story play --story <name>` 里的那个名字 */
  name: string
  title: string
  /**
   * 封面图**地址**（作者在 `story.yaml` 写的 `cover:`）。空 = 没给，展示层用占位。
   *
   * ⚠️ 引擎那侧刻意**不编一个默认地址**：默认长什么样是渲染的事、还会随皮肤/主题变，
   * 塞进接口就成了同一个判据两处声明。这条口只如实说「作者给没给」。
   */
  cover: string
  characters: number
  /** 场景数。没写 `stages:` 的故事引擎给 1（自动包的那个默认单场景） */
  scenes: number
  saves: number
}

export interface UnitRef {
  id: string
  label: string
}

export interface StoryCharacter {
  id: string
  name: string
  /** 角色卡的可观察表层描述（隐藏面住私有知识，不在这里） */
  description: string
  /**
   * 公共指代：不认得他的人该怎么称呼他。
   * **`null` 就是真的没有** —— 引擎刻意不拿真名顶这一格，因为缺 `public_ref` 正是运行期
   * 会降级成真名的那个形态，而这个字段存在的意义就是让它看得见。
   */
  publicRef: string | null
  hasProfile: boolean
  privateItems: number
  /** **显式**声明认得他的那些 observer（关系页缺省 knows=true，引擎不把缺省算进来） */
  knownBy: string[]
}

export interface StoryScene {
  id: string
  name: string
  /** 导演读得到的场景目标 */
  goal: string
  /** 转场判据。**导演读不到它** —— 收尾事件必须同时写进 goal，否则是死锁 */
  endWhen: string
  present: string[]
  /** 进场即执行的认知重置（时间循环类故事用） */
  resetCognition: string[]
  hasOpening: boolean
}

export interface StoryStage {
  id: string
  name: string
  brief: string
  scenes: StoryScene[]
}

export interface KnowledgeCounts {
  worldItems: number
  profiles: number
  privateItems: number
  relationDecls: number
}

/** story.yaml 上那几个节拍旋钮。**扁平一层** —— 前端要的是「这一项现在是什么」 */
export interface StoryPolicies {
  commitMaxTurns: number | null
  /** 单位是 **token**，量的是「还没被摘要覆盖的那段剧本线」，不是提示词峰值 */
  commitMaxContext: number | null
  relationEvery: string
  relationDigestEveryTurns: number
  relationTraceBaseline: number
  relationShowTracesToPlayer: boolean
  digestPriorScenes: number
  namingTransparent: boolean
  verifyRenderRole: boolean
  verifyRenderScene: boolean
  verifyIntegrate: boolean
  verifyProposeOptions: boolean
  agentloop: boolean
}

export interface StoryDetail {
  name: string
  title: string
  player: UnitRef
  playerDescription: string
  characters: StoryCharacter[]
  /** 空 = 没写 `stages:`，引擎自动包一个默认单场景（那类故事没有转场，也就没有回退点） */
  stages: StoryStage[]
  knowledge: KnowledgeCounts
  policies: StoryPolicies
  saves: number
  issues: LintIssue[]
}

// ── 存档 ────────────────────────────────────────────────────────────────────

/** 玩到哪了。引擎**现读文件系统**（`state/history/` 的分段文件名与行数），不进索引 */
export interface SaveProgress {
  turns: number
  stage: string
  scene: string
  /** 开过跑没有。建了存档 ≠ 开过跑 */
  started: boolean
  /** 引擎拼好的一句话，例如「第一幕 · 堂屋 · 3 轮」 */
  label: string
}

export interface SaveSummary {
  id: string
  story: string
  title: string
  created: string
  /** 版本后端：`git` 是缺省，`copy` 是没有 git 时的降级 */
  backend: string
  progress: SaveProgress
  /** 此刻在不在引擎内存里跑着（= 有没有装配过 StageRunner） */
  open: boolean
}

/** 一条故事线。回退恒开新线，原线一个字不动 */
export interface SaveLine {
  name: string
  /** 这条线最后一个存档点的场序；`-1`（SCENE_NONE）= 不是任何一场的起点 */
  sceneNo: number
  stage: string
  scene: string
  forkedFrom: string | null
  forkedAt: number | null
  current: boolean
}

// ── 对局 ────────────────────────────────────────────────────────────────────

/** 一个可选项。**意图粒度**：一句「要做什么」，不写台词 —— 台词由玩家步演绎 */
export interface PlayerOption {
  id: string
  text: string
}

/** 在场的一个单元（已按玩家视角落过词，`label` 不一定是真名） */
export interface PlayUnit {
  id: string
  label: string
}

export interface SceneRef {
  id: string
  name: string
}

/** 装配途中的一条通告：某片能力降级了、模板变了、前情退化了 */
export interface PlayNotice {
  level: string
  text: string
}

/**
 * 一局此刻的全貌。`GET /saves/{id}/state` 与事件流的 `STATE_SNAPSHOT` **是同一份** ——
 * 两条路给两种「当前状态」的话，刷新一次页面读到的就可能与刚才收到的对不上。
 */
export interface GameState {
  saveId: string
  story: string
  title: string
  line: string
  /** 对局序号：回退/切线之后会变。据它判断「手上这份状态是不是上一局的」 */
  epoch: number
  finished: boolean
  /** 下一次 run 是**开场轮**（引擎驱动、**不消费**玩家输入） */
  awaitingOpening: boolean
  stage: SceneRef
  scene: SceneRef
  sceneNo: number
  sceneCount: number
  turn: number
  present: PlayUnit[]
  options: PlayerOption[]
  lastNarrative: string
  player: PlayUnit
  notices: PlayNotice[]
}

/**
 * `POST /saves/{id}/turns` 的 202 回执。
 *
 * ⚠️ **`accepted: false` 不是失败**，是「已经有一轮在跑，这次是附着上去看」——
 * 此时 `consumedInput` 也是 false，那条消息**没有**被吃掉，别在界面上把它当成已发送。
 */
export interface TurnAccepted {
  saveId: string
  runId: string
  accepted: boolean
  consumedInput: boolean
  epoch: number
}

/** 一轮演完的结构化回执（事件流里 `CUSTOM:turn` 的载荷） */
export interface TurnReport {
  turn: number
  consumedInput: boolean
  playerNarrative: string
  narrative: string
  playerSegments: string[]
  options: PlayerOption[]
  sceneEnded: boolean
  finished: boolean
  reason: string
  committedItems: number
  retractedItems: number
}

/** 聊天历史里的一条（`GET /saves/{id}/messages` 与事件流的 `MESSAGES_SNAPSHOT` 同一形状） */
export interface ThreadMessage {
  id: string
  /** `user` = 玩家那一步；其余按 assistant 渲染 */
  role: string
  content: string
}

/**
 * 一轮**正在跑**的回合。
 *
 * ⚠️ **与 `SaveSummary.open` 不是一回事**：`open` 说的是「装配过、还在引擎内存里」，一局玩完
 * 放在那儿仍是 true；这一份说的是「有 worker 正在演」。故事列表要显示的「进行中」是后者。
 */
export interface RunningRun {
  saveId: string
  runId: string
  /** 存档刚被删掉时可能为空 —— 但这一条**仍然列出来**，它确实占着一个配额名额 */
  story: string
  title: string
  /** 已经跑了多久（秒） */
  elapsed: number
  epoch: number
}

/** 并发配额的现状。`limit` **由引擎给**（部署配置），前端不许写死一个数 */
export interface Quota {
  limit: number
  running: RunningRun[]
}

/**
 * 事件流上的一条事件（AG-UI 事件 + 引擎自定义的那几条）。
 *
 * 只把**用得到的**字段列出来：这是一条开放的流，引擎以后加事件不该让前端编译不过，
 * 故留 `[key: string]: unknown`。分支一律按 `type` / `name` 判，别按字段有没有判。
 */
export interface RunEvent {
  type: string
  /** `type === "CUSTOM"` 时才有：progress / phase / turn / notice / finished / quota … */
  name?: string
  value?: unknown
  /** STEP_STARTED / STEP_FINISHED */
  stepName?: string
  /** TEXT_MESSAGE_* */
  messageId?: string
  delta?: string
  role?: string
  /** RUN_ERROR */
  code?: string
  message?: string
  snapshot?: unknown
  [key: string]: unknown
}

/**
 * `CUSTOM:progress` 的载荷 —— **agent 执行流水线**的一步。
 *
 * ⚠️ 引擎那一侧刻意**只给环节名**（`plan` / `render_role` / …）与一句中文说明：
 * agent 标签冒号后面那半截是角色**真名**，而这条流直接推给玩家 —— 一个 `knows=false` 的
 * 角色在正文里落的是公共指代，进度条却把真名喊出来，就把认知隔离从侧门绕开了。
 * 同理提示词、输出原文、工具调用参数一概不在这条流上。
 */
export interface PipelineEvent {
  /** 环节名，例如 `render_role`。**这是环节不是人** —— 冒号后那截真名在引擎侧就丢掉了 */
  step: string
  /** 给人读的一句话，例如「角色演出中」。表里没有的环节回落成 step 本身，绝不猜 */
  label: string
  /**
   * 这一步归流水线的哪个阶段（`plan` / `perform` / `integrate` / `writeback` / …）。
   *
   * ⚠️ **由引擎给，前端不许自己按环节名再归一次**：谁在谁下面是执行顺序的事实，
   * 出处是引擎那张图。归第二遍就是同一个判据两处声明，而漂了不报错。
   */
  phase: string
  /**
   * 这一步是**哪一位 agent** 在跑（`director` / `actor` / `scene` / `player` / `options` /
   * `memory` / `bootstrap`）。
   *
   * ⚠️ **与 `phase` 正交，别拿一个推另一个**：阶段说的是「排在流水线的哪一段」，角色说的是
   * 「是谁」。同一位横跨好几个阶段（导演既排轮次卡又做汇总），同一个阶段里也坐着好几位
   * （演出那一段里有演员也有场景）。同样**由引擎给**（`progress.ROLES`）。
   *
   * **空串 = 附着型**（认知检索、输出核验）：它不是一位 agent，是某位 agent 正在做的一件事，
   * 故界面把它折进邻座那一行，跑的时候当作那一行的「此刻在做什么」标签，跑完就不显示了。
   */
  role: string
  /**
   * 这一步**单独占一行吗**。取料（`cognition`）与核验（`critique`）不占 —— 它们是**当次调用
   * 的一部分**，不是另一位 agent。
   *
   * ⚠️ **「附着」不等于「没有归属」**：上面那个 `role` 照样说得出是替谁做的（取料的视角就是
   * 那一位，核验继承它所核验的那次调用），故界面把它折回那一位名下，而不是让它变成一位没有
   * 名字的 agent 单独占一行。
   */
  attached: boolean
  /**
   * 这次调用**替谁跑** —— 角色卡上的**真名**（玩家给人设名）。空 = 这一步不针对某个角色
   * （导演规划、汇总、场景…）。
   *
   * ⚠️ **这里刻意不是玩家在正文里读到的那个词**（那是 `for_player` 的活）：流水线面板答的是
   * 「刚才那次调用是替谁跑的」，受众是开着这一局的人 —— 拿公共指代当运维标识的话，三个
   * `knows=false` 的角色在上面会是三条长得差不多的描述串，而它要回答的恰恰是「是哪一个」。
   * **正文一个字不受影响**：这个词只出现在进度事件上。
   *
   * ⚠️ **服务端给的就是这个词，前端不许再加工**：引擎那侧只发 id，落名在 `agui` 一处 ——
   * 因为只有那里拿得到 runner。这里再动一次就是同一个判据两处声明。
   */
  who: string
  /** 这次调用的形态：`complete` / `chat` / … */
  form: string
  /** 耗时（秒） */
  elapsed: number
  /**
   * 第几次传输尝试。**每次重发各记一条**，故同一个 step 可能连着出现好几条 ——
   * 那不是重复，是「这一步重发过」，界面上要看得出来。
   */
  attempt: number
  turn: number
  inputTokens: number
  outputTokens: number
  /** token 是服务端给的还是按字符估的 */
  tokensEstimated: boolean
  /** 这次失败的原因（截断到 200 字；完整栈在引擎的运行日志里）。空 = 没失败 */
  error: string
}

// ── 模型配置 ────────────────────────────────────────────────────────────────

/**
 * `agent_bindings` 的两个键 —— 它们就是「该指哪条连接」的等价类。
 *
 * ⚠️ **键名即判据**：这一维问的只有一件事 —— 这一步该不该为长链思考付钱。
 * 曾经是三类（`creative_text` / `creative_structured` / `mechanical`），其中
 * `creative_structured` 存在的全部理由是「有些端点上思考 × 结构化互斥」；引擎 2026-08-23
 * 起**一步都不发 schema**（产出恒是文本，结构由 `agent.shape` 提取），那条互斥结构性地
 * 消失，那一类也随之取消。
 */
export type AgentKind = "thinking" | "no_thinking"

/**
 * **引擎里的五位 agent。**
 *
 * ⚠️ 与 `AgentKind` 是**两根正交的轴**：那个问「这一步该不该为思考付钱」（路由轴），
 * 这个问「这一步是谁在干」（职能轴）。同一位横跨两种（导演既排轮次卡也做转场判定）。
 *
 * ⚠️ **`world` 与 `scene` 是两位**：场景 agent 演的是**这一场里**的环境与时间推移；
 * 世界 agent 干的是**开局把这个世界立起来**（建档四件事，跑在任何一场之前）。
 *
 * 归属**声明在引擎里、每位 agent 自己的模块中**（`narrative/agents/<环节>.py` 的 `ROLES`），
 * 随接口下发（`Binding.role` / `PipelineEvent.role`）——前端**不许**按环节名再归一次。
 */
export type AgentRole = "world" | "director" | "actor" | "scene" | "player"

export interface Connection {
  id: string
  provider: string
  model: string
  baseUrl: string
  /** **环境变量名**，不是值 —— key 从不进配置文件，也从不出这条接口 */
  apiKeyEnv: string
  timeoutS: number
  maxRetries: number
  /** 该模型的窗口（token）。引擎不内置模型表，只能按实际端点填 */
  contextWindow: number | null
  /** 提交触发线 = 窗口 × 它 */
  commitWatermark: number
  /**
   * **中立推理档位**（`off`/`minimal`/`low`/`medium`/`high`/`max`）。空串 = 没声明。
   *
   * ⚠️ **展示与编辑都用这一格，别用下面那个 `reasoningEffort`**（那是弃用的旧字段，
   * 只为存量配置还显示得出来）。厂商没有某一档时引擎**当作没声明并告警、绝不折算到邻近档**，
   * 故下拉框要按 provider 收窄到 `PROVIDER_REASONING` 里的那几档。
   */
  reasoning: string
  /** @deprecated 旧字段。新配置一律空；引擎装载期会点名让改成 `reasoning` */
  reasoningEffort: string
  /** 厂商私有信封里有没有关思考的声明。**只给「有没有」不给内容** */
  thinkingDisabled: boolean
  /** 会不会绑 tools 发请求。⚠️ 它今天**只**管工具循环（agentloop 检索 / skill） */
  toolCall: boolean
  stream: boolean
  idleTimeoutS: number | null
  /** 流式下两个内容块之间的间隔 —— 真正的卡顿检测 */
  chunkTimeoutS: number
  /** 单次调用的产出上界（token）。**不是**采样上限 `Preset.maxTokens`；0 = 关 */
  maxOutputTokens: number
  /** 单次调用的总时长上界（秒）。三道既有的闸都咬不住「上游一直在慢慢吐」这一档；0 = 关 */
  maxCallSeconds: number
  /** 流式下必须显式要 usage，否则 `commit.maxContext` 那个阈值永不触发且全程不报错 */
  streamUsage: boolean
  // ⚠️ **没有 `extraBody`**：那是原样透传的厂商私有信封、引擎自己都不解析，接口刻意只出
  // 「有没有关掉思考」这个结论（`thinkingDisabled`）而不出内容 —— 有些厂商的鉴权参数就走
  // 请求体。要改它就去改引擎那边的 config.yaml。
}

export interface Preset {
  id: string
  temperature: number
  topP: number | null
  topK: number | null
  maxTokens: number | null
}

/** 产出形状（引擎 `config.agent_kinds.OUTPUT_FORMS`）。`structured` 那一档 2026-08-23 已取消 */
export type OutputForm = "text" | "blocks" | "contract"

/** 三层优先级里，最终生效的那条来自哪一层 */
export type BindingSource = "override" | "kind" | "default"

/** 一个环节解析之后的样子 —— 配置页那张矩阵的一行。**这些值全由引擎算** */
export interface Binding {
  name: string
  /**
   * **这一步归哪一位 agent**。配置页按它分组。
   *
   * ⚠️ **引擎给的**（判据在那个环节自己的模块里），前端不许按环节名硬编码一张归类表 ——
   * 引擎把某个环节从一位挪给另一位时，前端不会有任何东西提醒，页面只是默默把它放错一组。
   */
  role: AgentRole
  /**
   * **归属由调用现场决定**：核验器跑在生成之后，核的是谁就归谁 —— 它伺候导演/演员/场景/
   * 玩家四位的产出，挂在其中任何一位名下都是错的，故配置页把这类**单列**。
   * 上面那个 `role` 对它只是回落值。
   */
  shared: boolean
  /**
   * **产物长什么形状**（`text` 自由文本或平坦字段 / `blocks` 一列重复块 / `contract` 切几段
   * 取其一）。⚠️ **纯描述性**：每个环节都交文本，这一格不再对应任何端点能力。
   */
  output: OutputForm
  /** 该不该为思考付钱。这是 `agent_bindings` 唯一的路由轴 */
  reasoning: boolean
  /** `agent_bindings` 里该查的键 */
  binding: AgentKind
  /** @deprecated 旧别名，等于 `binding` */
  kind: AgentKind
  /** @deprecated 旧别名，等于 `!reasoning` */
  mechanical: boolean
  connectionId: string
  source: BindingSource
  /** 这条连接在 connections[] 里存不存在。false = 运行时会回落，该环节的超时/预设全丢 */
  resolved: boolean
  presetId: string
  timeoutS: number | null
  maxRetries: number | null
  wallTimeoutS: number | null
  cognition: boolean | null
  /**
   * 单次调用的墙钟上界（秒）= `(重发预算 + 1) × 墙钟超时`，**每个环节同一条公式**。
   * 由引擎算好给出来（`AgentClients.time_budget_of`）—— 那个公式在引擎仓库里算错过一次，
   * 前端照抄一份只会把同一个错再犯一遍。
   */
  timeBudgetS: number
}

export interface ModelConfig {
  defaultConnect: string
  /** 三类全给，没配的那一格是空串 —— 「没配」本身是一个要显示的状态 */
  agentBindings: Record<AgentKind, string>
  connections: Connection[]
  presets: Preset[]
  bindings: Binding[]
  /**
   * **五位的显示顺序** —— 就是一轮里它们大致登场的顺序（建档 → 排这一轮 → 演出 → 玩家那一侧）。
   *
   * ⚠️ **引擎给的**（`roster.AGENT_ROLE_IDS`），前端别再排一份：那是同一个判据两处声明。
   * 中文名留在前端（那是**文案**，不是判据），顺序不是。
   */
  roleOrder: AgentRole[]
  issues: LintIssue[]
  /** 配置文件在哪 —— 改配置的人要知道该去动哪个文件 */
  sourceFile: string
  log: LogConfig
  /** 三态：null = 跟 story.yaml 走 · false = 总开关关 · true = 全开 */
  verify: boolean | null
  /** `+name` / `-name` 两层增量 */
  skills: string[]
  plugins: string[]
  /**
   * 作者在 `agents:` 里**显式写过**的覆盖项。
   *
   * ⚠️ **与 `bindings` 刻意不是同一个东西，别合并**：那一份是三层优先级算完的**解析结果**
   * （「现在实际指到哪」），这一份是**原始声明**（「你写过哪几行」）。而「这一格是空的」在
   * 两边含义相反 —— 解析结果里是回落值，原始声明里是没写。表单编辑的是这一份。
   */
  agents: AgentOverride[]
  /** 这份文件改不改得动。false 时不该给保存按钮 —— 一个点了必然 409 的按钮比没有更糟 */
  writable: boolean
  /** 改不动的原因（`writable` 为 false 时才有值）。照原文用，别在前端重编一份文案 */
  readOnlyReason: string
  /** 落盘格式。yaml 那一路写回会保住注释，json 没有注释可保 */
  format: "yaml" | "json"
}

/** `config.yaml log:` 那一段。CLI 与 HTTP 共用同一份配置，故这里改了命令行那边也跟着变 */
export interface LogConfig {
  enable: boolean
  level: string
  /** 完整提示词进不进日志文件 */
  prompts: boolean
  /** agent 输出原文进不进日志文件 */
  outputs: boolean
  /** 上面两类大块内容共用的截断上限；0 = 不截断 */
  maxChars: number
  /** 终端上的 token 计量（不是日志文件） */
  tokens: boolean
}

/** `agents[]` 里显式写过的那一项。**每一格都可以是 null = 没写**（回落到连接/缺省） */
export interface AgentOverride {
  name: string
  connectionId: string
  presetId: string
  cognition: boolean | null
  timeoutS: number | null
  maxRetries: number | null
  stream: boolean | null
  wallTimeoutS: number | null
  maxOutputTokens: number | null
  /**
   * 这个环节引擎认不认识。false = 运行期**静默回落**（连接/超时/提示词段全丢），
   * 只有装载期体检会 warning —— 故要在界面上显眼地标出来。
   */
  known: boolean
}

// ── 写回那一路 ──────────────────────────────────────────────────────────────
//
// **语义**：**省略一个字段 = 不动这一项**、**显式给 null = 写 null**。配置里一堆字段的 null
// 是**合法取值**（`topP` / `contextWindow` / `idleTimeoutS`…），拿 undefined/null 混作一谈
// 就等于把「把这一项清空」从接口上抹掉。故这里一律用可选字段（`?`），而值本身可以是 null。
//
// ⚠️ 引擎那一侧是 `extra="forbid"`：字段名打错一律 422，不会静默丢掉。

/** 顶层几个键。`log` 与 `agentBindings` 按键合并，只改一项时不必回传整段 */
export interface ConfigPatch {
  defaultConnect?: string
  verify?: boolean | null
  agentBindings?: Partial<Record<AgentKind, string>>
  log?: Partial<LogConfig>
  skills?: string[]
  plugins?: string[]
}

/** 一条连接。`id` 走路径 —— 改 id 是「删一条建一条」，不是一次 patch */
export interface ConnectionPatch {
  provider?: string
  model?: string
  baseUrl?: string
  /** **环境变量名**，永远不是值 */
  apiKeyEnv?: string
  timeoutS?: number
  maxRetries?: number
  toolCall?: boolean
  stream?: boolean
  idleTimeoutS?: number | null
  chunkTimeoutS?: number
  maxOutputTokens?: number
  maxCallSeconds?: number
  streamUsage?: boolean
  reasoning?: string
  contextWindow?: number | null
  commitWatermark?: number
}

export interface PresetPatch {
  temperature?: number
  topP?: number | null
  topK?: number | null
  maxTokens?: number | null
}

/** 一个环节的覆盖项。`name` 走路径，且必须是引擎认识的那些（否则 400） */
export interface AgentPatch {
  connectionId?: string
  presetId?: string
  cognition?: boolean | null
  timeoutS?: number | null
  maxRetries?: number | null
  stream?: boolean | null
  wallTimeoutS?: number | null
  maxOutputTokens?: number | null
}

/**
 * 一次写回的回执。
 *
 * **带着写完之后重新解析过的整份配置**：改一条连接会让若干环节的绑定、时间预算、体检结论
 * 一起变 —— 直接拿它替换本地状态，既省一次 GET，也堵掉「前端自己再算一遍三层优先级」那条
 * 明令禁止的路。
 */
export interface ConfigWriteResult {
  path: string
  /** 这次是新建还是改了既有项 */
  created: boolean
  config: ModelConfig
}

/** 中立推理档位的全集（引擎 `runtime.llm.REASONING_LEVELS`） */
export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "max"] as const

/**
 * **每个 provider 实际有哪几档**（引擎 `runtime.llm.PROVIDERS` 的镜像）。
 *
 * ⚠️ 表里没有的那一档**不是「差不多」**：引擎当作没声明并告警、**绝不折算到邻近档**，
 * 即那一行写下去思考开关根本不生效，而现象只是账单变了。故下拉框按 provider 收窄，
 * 别给一份全集让人挑到一个不生效的值（写口那边也会 400，这里是不让人走到那一步）。
 */
export const PROVIDER_REASONING: Record<string, readonly string[]> = {
  openai_compatible: ["off", "minimal", "low", "medium", "high"],
  deepseek: ["off", "low", "high", "max"],
}

/** provider 全集（引擎 `runtime.llm.PROVIDERS` 的键） */
export const PROVIDERS = Object.keys(PROVIDER_REASONING)
