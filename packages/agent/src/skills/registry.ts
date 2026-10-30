import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import { Type } from '@mariozechner/pi-ai'
import type { AgentSkillId } from '@shadecn/shared/agent'
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
 * `requires` 是它全部工具所需能力的并集（注册表建立时校验），**只用来判断提不提供**。
 * 网关另外拒绝执行本轮没加载的技能里的工具（docs/23 §3.3）—— 两道检查，不合并。
 */

/** 会话绑定的节点（节点范围会话，docs/07 §7.4）；普通会话没有 */
export interface SkillBoundNode {
  id: string
  /** 一轮开始时读到的节点类型；节点已经不在画布上了为 null */
  type: string | null
  /** 节点名；节点已经不在了为 null */
  label: string | null
}

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
  /** 节点范围会话绑定的节点；普通会话为 null */
  boundNode: SkillBoundNode | null
}

/**
 * 构造工具时给的上下文。服务端（`side: 'server'`）给真实画布、本轮共享的 `runState`、素材读取；
 * runner（`side: 'runner'`）的画布一读写就报错（工具只拿定义，执行走网关），`sandbox` 是它自己的工作目录。
 * 工具在 `execute` 里拿 `boundNode` 校验参数（{@link assertBoundNode}）—— 执行永远在服务端，那里的值才算数。
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
  boundNode: SkillBoundNode | null
}

export type SkillActivation = 'always' | 'auto' | 'on-demand'

export interface AgentSkill {
  /** 发布后不改：对话记录里存的就是它。小写字母、数字、`-` */
  id: AgentSkillId
  /** 给人看：「画布（只读）」 */
  title: string
  /** 一句话，放进系统提示的技能目录，模型据此判断要不要加载 */
  summary: string
  /** 加载后放进上下文的说明段（用法、规则、限额）：一开始就加载的进系统提示，按需加载的随 `load_skill` 的结果给 */
  prompt: string
  /** 工具定义；runner 和服务端从同一份构造。工具名全局唯一，一个工具只属于一个技能 */
  tools(ctx: SkillContext): CanvasTool[]
  /** Grant 里缺任何一项，这个技能就不提供。必须覆盖它全部工具的 `capability`（注册表建立时校验） */
  requires: readonly AgentCapability[]
  /** 部署 / 会话条件：模型吃不吃图、有没有对象存储、是不是节点范围会话……不给 = 总是可用 */
  available?(env: SkillAvailability): boolean
  /**
   * - `always`：提供了就一开始加载；
   * - `auto`：命中 `activatesFor` 时一开始加载（会话绑定的节点是这种类型，或用户这条消息 `@` 提及了这种类型的节点），否则同 `on-demand`；
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
export function definitionContext(
  side: SkillContext['side'],
  boundNode: SkillBoundNode | null = null,
  sandbox: Sandbox = NO_SANDBOX,
): SkillContext {
  return { side, canvas: NO_CANVAS, runState: { deleted: 0, mediaBytes: 0 }, sandbox, boundNode }
}

/**
 * 节点范围会话里，技能工具点名的节点必须就是会话绑定的那个（docs/07 §7.4「只能改它绑定的这个导演台」）。
 * 普通会话不限制。在工具的 `execute` 里调（服务端执行，`ctx.boundNode` 是服务端读到的）。
 */
export function assertBoundNode(ctx: Pick<SkillContext, 'boundNode'>, nodeId: string): void {
  const bound = ctx.boundNode
  if (bound && nodeId !== bound.id) {
    throw new Error(`这个会话绑定节点 ${bound.id}，只能操作它；${nodeId} 不在本会话的范围内`)
  }
}

// —— load_skill ——

/** 加载技能的平台工具：不属于任何技能，每一轮都给 */
export const LOAD_SKILL_TOOL_NAME = 'load_skill'

/** 同一批里还有别的工具调用时，runner 拦下 load_skill 回给模型的原因 */
export const LOAD_SKILL_ALONE_REASON = 'load_skill 必须单独调用：这一批里还有别的工具调用，已拦下这次加载。请先让别的工具做完，再单独调用 load_skill'

const loadSkillParams = Type.Object(
  { id: Type.String({ pattern: SKILL_ID_PATTERN, description: '要加载的技能 id（见系统提示里的技能目录）' }) },
  { additionalProperties: false },
)

/**
 * `load_skill` 的定义。服务端传 `load`（判提供集合 / 是否已加载 / 每轮上限，见 `session.ts`）；
 * runner 不传，只拿定义包成网关代理。成功加载时结果带 `terminate: true` 和 `details.loadedSkill`：
 * 这一批就此结束，runner 把新技能的工具并进 `agent.state.tools` 再 `continue()`（docs/23 §3.3）。
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
}

/** 一轮的技能集合（docs/23 §3.2） */
export interface SkillPlan {
  /** 提供的：`requires` 全在 Grant 里、`available` 为真。按注册顺序 */
  offered: AgentSkill[]
  /** 一开始就加载的（`always`、命中的 `auto`、之前加载过且这一轮仍提供的） */
  loaded: AgentSkill[]
  /** 提供了但没加载的：进系统提示末尾的技能目录 */
  catalog: AgentSkill[]
  /** 之前加载过、这一轮不提供的（Grant / 部署条件变了，或注册表里已经没有它）：系统提示里说明 */
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
 * `runner` 执行的工具所在技能必须要求 `sandbox:exec`。违反任何一条都在建表时抛出（开发期就炸，不留到某一轮）。
 */
export function createSkillRegistry(skills: readonly AgentSkill[]): SkillRegistry {
  const byId = new Map<string, AgentSkill>()
  const toolOwner = new Map<string, AgentSkill>()
  for (const skill of skills) {
    if (byId.has(skill.id)) throw new Error(`技能 id 重复：${skill.id}`)
    byId.set(skill.id, skill)
    for (const tool of skill.tools(definitionContext('runner'))) {
      if (tool.name === LOAD_SKILL_TOOL_NAME) throw new Error(`技能 ${skill.id} 的工具不能叫 ${LOAD_SKILL_TOOL_NAME}`)
      const other = toolOwner.get(tool.name)
      if (other) throw new Error(`工具 ${tool.name} 同时属于技能 ${other.id} 和 ${skill.id}`)
      toolOwner.set(tool.name, skill)
      if (!skill.requires.includes(tool.capability)) {
        throw new Error(`技能 ${skill.id} 的 requires 没有覆盖工具 ${tool.name} 要的 ${tool.capability}`)
      }
      if (tool.execution === 'runner' && !skill.requires.includes('sandbox:exec')) {
        throw new Error(`工具 ${tool.name} 在 runner 里执行，技能 ${skill.id} 必须要求 sandbox:exec`)
      }
    }
  }

  const offers = (skill: AgentSkill, env: SkillAvailability) =>
    skill.requires.every((capability) => env.scopes.has(capability)) && (skill.available?.(env) ?? true)

  const autoHit = (skill: AgentSkill, input: SkillPlanInput) => {
    const types = skill.activatesFor?.nodeTypes ?? []
    const bound = input.env.boundNode?.type
    return (bound != null && types.includes(bound)) || input.mentionedNodeTypes.some((type) => types.includes(type))
  }

  return {
    skills,
    get: (id) => byId.get(id),
    skillOfTool: (name) => toolOwner.get(name),
    titleOf: (id) => byId.get(id)?.title ?? id,
    offers,
    plan(input) {
      const previous = new Set(input.previous)
      const offered = skills.filter((skill) => offers(skill, input.env))
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
