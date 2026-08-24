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
  /** 关思考的声明；本地 ollama /v1 上只有 `none` 被认。空串 = 没写 */
  reasoningEffort: string
  /** 厂商私有信封里有没有关思考的声明。**只给「有没有」不给内容** */
  thinkingDisabled: boolean
  /** 会不会绑 tools 发请求。⚠️ 它今天**只**管工具循环（agentloop 检索 / skill） */
  toolCall: boolean
  stream: boolean
  idleTimeoutS: number | null
  /** 流式下两个内容块之间的间隔 —— 真正的卡顿检测 */
  chunkTimeoutS: number
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
  issues: LintIssue[]
  /** 配置文件在哪 —— 改配置的人要知道该去动哪个文件 */
  sourceFile: string
}
