import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { AgentAttachment, AgentSkillId } from '@shadecn/shared/agent'
import type { AgentCapability } from '../authority.ts'
import type { CanvasHandle } from '../canvas.ts'
import type { MediaReader } from '../media.ts'
import type { Sandbox } from '../sandbox/types.ts'
import type { CanvasTool, CanvasToolDetails, ToolRunState } from '../tools.ts'

export type { AgentSkillId } from '@shadecn/shared/agent'

/**
 * 内置技能（docs/23）：一组原子工具 + 配套的提示段 + 所需能力 + 可用条件，作为一个整体被提供、加载和展示。
 * 底层仍是 pi 的 `AgentTool`（{@link CanvasTool}），这里不引入新的 agent 框架。
 *
 * ## 两侧共用
 *
 * **runner 和服务端从同一份注册表构造工具**（docs/23 §3.5）：服务端拿真实画布造会执行的工具，
 * runner 拿 {@link definitionContext}（没有画布）造定义、再包成网关代理。所以这个目录属于两侧共用的代码，
 * **不能 import 服务端模块**（`session` / `gateway` / `store` / `canvas-changes`，规则同 `.claude/rules/agent.md`）。
 *
 * ## 技能不授予权限
 *
 * 技能只决定「把哪些工具交给模型」。每个工具执行前照样按自己的 `capability` 在网关判权；
 * `requires` 是它全部工具所需能力的并集（注册表建立时校验），和 `offeredWith` 一起**只用来判断提不提供**。
 * 网关另外拒绝执行本轮没加载的技能里的工具（docs/23 §3.3）—— 两道检查，不合并。
 */

/** 部署条件：宿主的配置与模型的能力（服务端一轮开始时算好） */
export interface SkillDeployment {
  /** 模型支持图片输入（`model.input` 含 `image`；`AGENT_IMAGE_INPUT` 可覆盖） */
  imageInput: boolean
  /** 宿主接了素材读取（配了对象存储，`MediaReader`） */
  mediaReader: boolean
  /** 宿主开了沙箱里的命令执行（apps/server：`AGENT_SANDBOX_EXEC=1`） */
  sandboxExec: boolean
}

/** 判断一个技能「提不提供」看的东西（docs/23 §3.2 第 1 步） */
export interface SkillAvailability {
  /** 这一轮 Grant 里的能力 */
  scopes: ReadonlySet<AgentCapability>
  deployment: SkillDeployment
}

/**
 * 构造工具时给的上下文。服务端（`side: 'server'`）给真实画布、本轮共享的 `runState`、素材读取；
 * runner（`side: 'runner'`）的画布一读写就报错（工具只拿定义，执行走网关），`sandbox` 是它自己的工作目录。
 *
 * 这里**没有会话范围**：所有会话都是全局 agent，作用域是整张画布（docs/20 §3.10.9）。会话的 `nodeId` 只记入口，
 * 不进上下文 —— 别据它限制工具点名哪个节点，也别据它决定加载哪些技能（加载靠提及）。
 */
export interface SkillContext {
  side: 'server' | 'runner'
  canvas: CanvasHandle
  /** 一轮里工具之间共享的预算（删除、图片字节）；同一轮的所有技能拿同一份 */
  runState: ToolRunState
  /** 只有服务端、且宿主接了素材读取时有 */
  media?: MediaReader
  /**
   * runner 工具（`execution: 'runner'`）跑命令用的沙箱：runner 里是这一轮的工作目录（技能 `requires` 含 `sandbox:exec` 时才开）；
   * 服务端是只给定义用的桩，一调就报错（网关从不代 runner 工具执行）
   */
  sandbox: Sandbox
  /**
   * 这个会话里用户消息带过的附件（docs/20 §3.10.12，宿主核对过归属）：`view_attachment` 只认这些。
   * 只有服务端有；runner 只造定义，不给
   */
  attachments?: readonly AgentAttachment[]
  /**
   * 可调用的 agent（docs/26 §3.5，`run_agent` 的 `agent` 取值与工具描述里的目录）：服务端取 agent 注册表，runner 取 `RunnerInput.agents`，
   * 两侧造出同一份工具定义。只拿定义（注册表自检）时不给
   */
  agents?: readonly { name: string; description: string }[]
  /**
   * 发起任务并等它做完（docs/20 §3.10.11，`run_agent` 的执行）：**只有 runner 里、能调用别的 agent 的那个 agent 的上下文有**
   * （它的技能里有 `agents`，即调用深度没到上限；runner 实现：网关登记 → 同一进程里再建一个 pi `Agent` → 交回结果）。
   * 服务端的上下文没有，一调就报错
   */
  runAgent?: (
    toolCallId: string,
    args: { agent: string; task: string; nodeIds?: string[] },
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<CanvasToolDetails>>
}

export type SkillActivation = 'always' | 'auto' | 'on-demand'

export interface AgentSkill {
  /** 发布后不改：对话记录里存的就是它。小写字母、数字、`-` */
  id: AgentSkillId
  /** 给人看：「画布」「导演台」 */
  title: string
  /** 一句话，放进系统提示的技能目录，模型据此判断要不要加载 */
  summary: string
  /** 加载后放进上下文的说明段（用法、规则、限额）：一开始就加载的进系统提示，按需加载的随 `load_skill` 的结果给 */
  prompt: string
  /** 工具定义；runner 和服务端从同一份构造。工具名全局唯一，一个工具只属于一个技能 */
  tools(ctx: SkillContext): CanvasTool[]
  /**
   * 它全部工具所需能力的并集：必须覆盖每个工具的 `capability`（注册表建立时校验）。
   * 不给 {@link offeredWith} 时，Grant 里缺任何一项，这个技能就不提供。
   */
  requires: readonly AgentCapability[]
  /**
   * 提供的门槛（⊆ `requires`，注册表建立时校验）：Grant 里有这几项就提供，缺的那些能力对应的工具在网关逐个判权时被拒。
   * 给基础技能用 —— `canvas` 只要 `flow:read` 就提供，没有写权限时照样能读（docs/23 §4）。不给 = `requires` 全部。
   */
  offeredWith?: readonly AgentCapability[]
  /** 部署条件：模型吃不吃图、有没有对象存储、开没开沙箱执行……不给 = 总是可用 */
  available?(env: SkillAvailability): boolean
  /**
   * - `always`：提供了就一开始加载；
   * - `auto`：命中 `activatesFor` 时一开始加载（用户这条消息 `@` 提及了这种类型的节点），否则同 `on-demand`；
   * - `on-demand`：进技能目录，模型调 `load_skill` 加载。
   */
  activation: SkillActivation
  activatesFor?: { nodeTypes?: readonly string[] }
  /**
   * 服务端初始化钩子：一轮开始时，对**提供了的**技能调一次，返回写进 runner 工作目录的文件（相对路径 → 内容）。
   * runner 只在提供的技能里有人要 `sandbox:exec` 时才开工作目录，所以只有这类技能给它才有意义。
   */
  workdirFiles?(ctx: { canvas: CanvasHandle }): Promise<Record<string, string>>
}

/** 定义一个技能：只做形状上的检查（id、activation 与 activatesFor 配对）；工具层面的检查在 {@link createSkillRegistry} */
export function defineSkill(skill: AgentSkill): AgentSkill {
  if (!SKILL_ID_REGEX.test(skill.id)) throw new Error(`技能 id 不合法：${skill.id}`)
  if (skill.activation === 'auto' && !skill.activatesFor?.nodeTypes?.length) {
    throw new Error(`技能 ${skill.id} 是 auto，但没有声明 activatesFor.nodeTypes`)
  }
  if (skill.activation !== 'auto' && skill.activatesFor) {
    throw new Error(`技能 ${skill.id} 不是 auto，不该声明 activatesFor`)
  }
  return skill
}

const SKILL_ID_PATTERN = '^[a-z][a-z0-9-]{0,47}$'
const SKILL_ID_REGEX = new RegExp(SKILL_ID_PATTERN)

// —— 只给定义用的上下文 ——

const rejectCanvas = () => Promise.reject(new Error('这里没有画布：画布工具只能经网关在服务端执行'))

/** 没有画布的画布句柄：runner 和注册表自检用，读写一律报错 */
export const NO_CANVAS: CanvasHandle = { flowId: '', read: rejectCanvas, write: rejectCanvas }

const rejectSandbox = () => Promise.reject(new Error('这里没有沙箱工作目录：runner 工具只在 runner 里执行'))

/** 没有工作目录的沙箱：服务端给 runner 工具造定义用，一调就报错 */
export const NO_SANDBOX: Sandbox = {
  workdir: '',
  writeFile: rejectSandbox,
  readFile: rejectSandbox,
  exec: rejectSandbox,
  dispose: async () => {},
}

/** 只为拿工具定义（名字、schema、描述、能力、执行位置）的上下文 */
export function definitionContext(side: SkillContext['side'], sandbox: Sandbox = NO_SANDBOX): SkillContext {
  return { side, canvas: NO_CANVAS, runState: { deleted: 0, mediaBytes: 0 }, sandbox }
}

// —— load_skill ——

/** 加载技能的平台工具：不属于任何技能，每一轮都给 */
export const LOAD_SKILL_TOOL_NAME = 'load_skill'

/** 被调用的 agent 的平台工具「需要确认」（`skills/agents/`）：不属于任何技能，技能里的工具不能叫这个名字 */
export const REQUEST_CONFIRMATION_TOOL_NAME = 'request_confirmation'

/**
 * 工具调用次数到顶时给模型的话：网关拒绝它执行的调用（含 `run_agent`）、runner 在执行前拦下它自己执行的命令时用同一句
 * （docs/22 §4.3 第 4 步；原来是 pi 的 `beforeToolCall` 给的，模型看到的一字不变）
 */
export const toolCallLimitReason = (max: number) => `本轮工具调用已达上限 ${max} 次，请停止并向用户说明进度`

/** 同一批里还有别的工具调用时，网关拒绝 load_skill 回给模型的原因（原来是 runner 拦下时给的，一字不变） */
export const LOAD_SKILL_ALONE_REASON = 'load_skill 必须单独调用：这一批里还有别的工具调用，已拦下这次加载。请先让别的工具做完，再单独调用 load_skill'

const loadSkillParams = Type.Object(
  { id: Type.String({ pattern: SKILL_ID_PATTERN, description: '要加载的技能 id（见系统提示里的技能目录）' }) },
  { additionalProperties: false },
)

/**
 * `load_skill` 的定义。服务端传 `load`（判提供集合 / 是否已加载 / 每轮上限，见 `session.ts`）；
 * runner 不传，只拿定义包成网关代理。成功加载时结果带 `details.loadedSkills`（新加载的内置技能）：
 * runner 在 pi 的 `prepareNextTurnWithContext` 里把新技能的工具并进下一次请求（docs/23 §3.3）。必须单独调用由网关判（`session.ts` 的 `executeBound`）。
 */
export function createLoadSkillTool(
  load?: (id: string) => Promise<AgentToolResult<CanvasToolDetails>>,
): CanvasTool<typeof loadSkillParams> {
  return {
    name: LOAD_SKILL_TOOL_NAME,
    capability: 'flow:read',
    label: '加载技能',
    description:
      '加载系统提示「技能目录」里的一个技能：它的工具从下一步起可用，它的用法说明在这次的结果里。' +
      '必须单独调用（同一次回复里不要再调别的工具）；已经加载的技能不用再加载；一轮最多加载几次，超了会被拒绝。',
    parameters: loadSkillParams,
    executionMode: 'sequential',
    describe: (args) => `加载技能 ${args.id}`,
    async execute(_id, args) {
      if (!load) throw new Error('load_skill 只能经网关在服务端执行')
      return load(args.id)
    },
  }
}

// —— 注册表 ——

export interface SkillPlanInput {
  env: SkillAvailability
  /** 这个会话之前加载过的技能（存在会话上的，只增不减） */
  previous: readonly AgentSkillId[]
  /** 用户这条消息 `@` 提及的节点的类型（不存在的节点不算） */
  mentionedNodeTypes: readonly string[]
  /** 这次不提供的技能（调用深度到了上限的 agent 不给 `agents`，docs/26 §3.5） */
  exclude?: readonly AgentSkillId[]
  /**
   * agent 定义的工具白名单（docs/26 §3.3，`agents.ts` 的 `agentToolWhitelist`）；不给 / `null` = 不收窄。
   * 白名单把一个技能的工具全滤掉了，这个技能对这个 agent 就**不提供**（不进技能目录、不能加载、不算一开始加载的、
   * 之前加载过的进「本轮不可用」）。只收窄、不放宽：门槛和部署条件照旧先判。技能里留下哪几个工具由调用方按同一份白名单滤（session.ts）
   */
  allowedTools?: ReadonlySet<string> | null
}

/** 一轮的技能集合（docs/23 §3.2） */
export interface SkillPlan {
  /** 提供的：门槛（`offeredWith`，缺省 `requires`）全在 Grant 里、`available` 为真、工具白名单没把它滤空。按注册顺序 */
  offered: AgentSkill[]
  /** 一开始就加载的（`always`、命中的 `auto`、之前加载过且这一轮仍提供的） */
  loaded: AgentSkill[]
  /** 提供了但没加载的：进系统提示末尾的技能目录 */
  catalog: AgentSkill[]
  /** 之前加载过、这一轮不提供的（Grant / 部署条件变了、agent 的工具白名单不含它的工具，或注册表里已经没有它）：系统提示里说明 */
  unavailable: AgentSkillId[]
}

export interface SkillRegistry {
  readonly skills: readonly AgentSkill[]
  get(id: string): AgentSkill | undefined
  /** 工具属于哪个技能（`load_skill` 不属于任何技能） */
  skillOfTool(name: string): AgentSkill | undefined
  /** 给人看的标题；注册表里已经没有的技能就是 id 本身 */
  titleOf(id: string): string
  offers(skill: AgentSkill, env: SkillAvailability): boolean
  plan(input: SkillPlanInput): SkillPlan
}

/**
 * 建注册表，并校验全部技能的工具（用没有画布的上下文造一遍定义）：
 * 技能 id 不重复；工具名全局唯一、不和 `load_skill` 撞；`requires` 覆盖每个工具的 `capability`；
 * `offeredWith` ⊆ `requires`；要起子进程的工具（`spawnsProcess`）必须在 runner 里执行、所在技能必须要求 `sandbox:exec`。
 * 违反任何一条都在建表时抛出（开发期就炸，不留到某一轮）。
 *
 * 「在 runner 里执行」本身不要求 `sandbox:exec`：`run_agent` 在 runner 里跑，但不起进程，被调用的 agent 的每一步
 * （模型请求、画布工具）仍是经网关判权的普通请求；要求 `sandbox:exec` 的只有真在工作目录里起子进程的那种（ffmpeg）。
 */
export function createSkillRegistry(skills: readonly AgentSkill[]): SkillRegistry {
  const byId = new Map<string, AgentSkill>()
  const toolOwner = new Map<string, AgentSkill>()
  /** 每个技能的工具名（定义顺序）：按白名单判「还剩不剩工具」用 */
  const toolNames = new Map<string, string[]>()
  for (const skill of skills) {
    if (byId.has(skill.id)) throw new Error(`技能 id 重复：${skill.id}`)
    byId.set(skill.id, skill)
    const names: string[] = []
    toolNames.set(skill.id, names)
    for (const capability of skill.offeredWith ?? []) {
      if (!skill.requires.includes(capability)) {
        throw new Error(`技能 ${skill.id} 的 offeredWith 里的 ${capability} 不在 requires 里`)
      }
    }
    for (const tool of skill.tools(definitionContext('runner'))) {
      if (tool.name === LOAD_SKILL_TOOL_NAME || tool.name === REQUEST_CONFIRMATION_TOOL_NAME) {
        throw new Error(`技能 ${skill.id} 的工具不能叫 ${tool.name}（平台工具的名字）`)
      }
      const other = toolOwner.get(tool.name)
      if (other) throw new Error(`工具 ${tool.name} 同时属于技能 ${other.id} 和 ${skill.id}`)
      toolOwner.set(tool.name, skill)
      names.push(tool.name)
      if (!skill.requires.includes(tool.capability)) {
        throw new Error(`技能 ${skill.id} 的 requires 没有覆盖工具 ${tool.name} 要的 ${tool.capability}`)
      }
      if (tool.spawnsProcess && tool.execution !== 'runner') {
        throw new Error(`工具 ${tool.name} 要起子进程，只能在 runner 里执行（execution: 'runner'）`)
      }
      if (tool.spawnsProcess && !skill.requires.includes('sandbox:exec')) {
        throw new Error(`工具 ${tool.name} 要在 runner 里起子进程，技能 ${skill.id} 必须要求 sandbox:exec`)
      }
    }
  }

  const offers = (skill: AgentSkill, env: SkillAvailability) =>
    (skill.offeredWith ?? skill.requires).every((capability) => env.scopes.has(capability)) && (skill.available?.(env) ?? true)

  /** 白名单之后还剩工具（本来就没有工具的技能不算被滤掉） */
  const survives = (skill: AgentSkill, allowed: ReadonlySet<string> | null | undefined) => {
    if (!allowed) return true
    const names = toolNames.get(skill.id) ?? []
    return names.length === 0 || names.some((name) => allowed.has(name))
  }

  const autoHit = (skill: AgentSkill, input: SkillPlanInput) => {
    const types = skill.activatesFor?.nodeTypes ?? []
    return input.mentionedNodeTypes.some((type) => types.includes(type))
  }

  return {
    skills,
    get: (id) => byId.get(id),
    skillOfTool: (name) => toolOwner.get(name),
    titleOf: (id) => byId.get(id)?.title ?? id,
    offers,
    plan(input) {
      const previous = new Set(input.previous)
      const excluded = new Set(input.exclude ?? [])
      const offered = skills.filter(
        (skill) => !excluded.has(skill.id) && offers(skill, input.env) && survives(skill, input.allowedTools),
      )
      const loaded = offered.filter(
        (skill) =>
          skill.activation === 'always' ||
          (skill.activation === 'auto' && autoHit(skill, input)) ||
          previous.has(skill.id),
      )
      const loadedIds = new Set(loaded.map((skill) => skill.id))
      const offeredIds = new Set(offered.map((skill) => skill.id))
      return {
        offered,
        loaded,
        catalog: offered.filter((skill) => !loadedIds.has(skill.id)),
        unavailable: [...previous].filter((id) => !offeredIds.has(id)),
      }
    },
  }
}
