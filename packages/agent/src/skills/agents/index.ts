import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { AGENT_RUN_TOOL_NAME } from '@shadecn/shared/agent'
import { AGENT_TASK_MAX, AGENT_TASK_NODE_IDS_MAX } from '../../protocol.ts'
import type { CanvasTool } from '../../tools.ts'
import { defineSkill, REQUEST_CONFIRMATION_TOOL_NAME, type SkillContext } from '../registry.ts'

/**
 * 任务技能 `agents`（docs/20 §3.10.11、docs/26 §3.5）：一个 agent 把一件事交给另一个 agent（可以是别的定义，也可以是同一个）在同一轮里做。
 * `always`；**调用深度到了上限的 agent 不提供**（服务端给它定技能时排除它，也拒绝它发起的任务）；定义的工具白名单里没有 `run_agent` 也不提供。
 * runner 协议第 8 版之前叫 `delegate`（工具 `delegate_task`）—— 存着旧 id 的会话经 shared 的 `AGENT_SKILL_ID_ALIASES` 读成 `agents`。
 *
 * `run_agent` 在 runner 里执行（`execution: 'runner'`）：runner 先经网关登记（服务端分配 id、判调用深度与上限、转交占用），
 * 再在**同一个进程**里建一个独立的 pi `Agent` 跑被调用的 agent，**等它做完**才返回 —— 被调用的 agent 的每一次模型请求、画布工具调用
 * 都是正常的网关请求（判权、预算照旧），所以它不起子进程，也就不要求 `sandbox:exec`（`spawnsProcess` 不设）。
 *
 * 并行：它是 `executionMode: 'parallel'`，别的工具一律 `sequential`（runner 统一设）；pi 的规则（1.4 仍然如此）是**一批里只要有一个
 * sequential 就整批顺序执行**，所以「同一批全是 run_agent」才并行，混了别的工具就整批按顺序。
 *
 * `agent` 参数的取值和工具描述里的目录来自 {@link SkillContext.agents}（服务端：agent 注册表；runner：`RunnerInput.agents`）——
 * 两侧造出同一份定义，pi 在 runner 里校验参数和服务端预判（`transcript.ts` 的 `recordReply`）用的是同一个 schema。
 */

export const AGENTS_SKILL_ID = 'agents'

function runAgentParams(ctx: SkillContext) {
  const names = (ctx.agents ?? []).map((agent) => agent.name)
  return Type.Object(
    {
      agent: names.length > 0
        ? Type.Enum(names, { description: '交给哪个 agent（见工具描述里的「可调用的 agent」）' })
        : Type.String({ minLength: 1, description: '交给哪个 agent（见工具描述里的「可调用的 agent」）' }),
      task: Type.String({
        minLength: 1,
        maxLength: AGENT_TASK_MAX,
        description: '交给它的任务说明：要做什么、做到什么程度、有什么约束。被调用的 agent 看不到你的对话，说明要自足',
      }),
      nodeIds: Type.Optional(
        Type.Array(Type.String({ pattern: '^[A-Za-z0-9_-]{1,64}$' }), {
          maxItems: AGENT_TASK_NODE_IDS_MAX,
          description: '它要处理的节点 id（会作为提及放进它的第一条消息，附上这些节点当前的内容；导演台节点会让它自动加载导演台技能）',
        }),
      ),
    },
    { additionalProperties: false },
  )
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** `run_agent` 的参数（`agent` 是定义名，见 {@link runAgentParams}） */
export interface RunAgentArgs {
  agent: string
  task: string
  nodeIds?: string[]
}

export function createRunAgentTool(ctx: SkillContext): CanvasTool {
  const catalog = (ctx.agents ?? []).map((agent) => `- ${agent.name}：${agent.description}`).join('\n')
  return {
    name: AGENT_RUN_TOOL_NAME,
    // 发起本身只是读：被调用的 agent 的每次写都按各自工具的能力在网关上判
    capability: 'flow:read',
    label: '发起任务',
    description:
      '把一件独立的事交给一个 agent 去做，等它做完返回它的结果（最终回复摘要和它改过的节点）。' +
      '要并行做几件互不相干的事时，在同一次回复里调用多次 run_agent（同一批全是它才会并行）；' +
      '被调用的 agent 不能直接问用户：需要确认时它会交回一个问题，由你决定怎么办。' +
      (catalog ? `\n\n可调用的 agent：\n${catalog}` : ''),
    parameters: runAgentParams(ctx),
    execution: 'runner',
    executionMode: 'parallel',
    describe: (args) => {
      const { agent, task } = args as RunAgentArgs
      return `任务（${agent}）：${clip(task.replace(/\s+/g, ' '), 60)}`
    },
    async execute(toolCallId, args, signal) {
      if (!ctx.runAgent) throw new Error('run_agent 只能在 runner 里、由能调用别的 agent 的 agent 执行')
      return ctx.runAgent(toolCallId, args as RunAgentArgs, signal)
    },
  }
}

export const agentsSkill = defineSkill({
  id: AGENTS_SKILL_ID,
  title: '任务',
  summary: '把大任务拆成几件独立的事，交给合适的 agent 并行执行，等它们做完拿回结果摘要',
  prompt: `- run_agent({ agent, task, nodeIds? }) 把一件独立的事交给一个 agent 去做，**等它做完**才返回：结果里是它的最终回复（摘要）和它改过的节点，不含它的过程。
- agent 选谁：看 run_agent 工具描述里「可调用的 agent」—— 每个 agent 有自己的系统提示、工具和模型（例如只读的审查 agent 改不了节点）。同一种事也可以交给和你一样的 agent。
- 什么时候用：任务能拆成几件**互不相干**的事（例如「分别给这三个导演台各搭一个场景」），或某一步要读写大量内容、会把你的上下文撑满（场景数据、测量结果）。一两步就能做完的事自己做，不要发起任务。
- 并行：要同时做的几件事，在**同一次回复里**各调一次 run_agent（这一批只放 run_agent，混进别的工具就会按顺序一件件做）。同时最多 3 个，一轮累计最多 10 个，超出会被拒绝。
- task 要自足：被调用的 agent 看不到你的对话，写清楚要做什么、做到什么程度、不要碰什么；它要处理的节点放进 nodeIds（不要让两个任务改同一个节点 —— 后写的那个会被拒绝）。
- 你正占用着的节点（你改过它的数据）交给被调用的 agent 时，占用转给它；它结束就释放，你之后要再改得重新占用。
- 任务失败：结果里有原因，你决定重新发起、换个做法，还是如实说明。任务「需要确认」：它遇到了要问人的情况（节点正被别人修改、和别人的改动冲突……），结果里带着它的问题 —— 由你判断：需要问人时，你在和用户对话就停下来问用户；你自己也是被调用的 agent 就用 request_confirmation 把问题交回你的调用方。`,
  tools: (ctx) => [createRunAgentTool(ctx)],
  requires: ['flow:read'],
  activation: 'always',
})

const confirmParams = Type.Object(
  {
    question: Type.String({
      minLength: 1,
      maxLength: 2000,
      description: '要交回给调用方（由它决定怎么办，需要时再问用户）的问题：遇到了什么情况、需要谁确认什么',
    }),
  },
  { additionalProperties: false },
)

/**
 * 被调用的 agent 的平台工具「需要确认」：被调用的 agent 不直接问人（docs/20 §3.10.11），遇到「正在被别人修改」「和别人的改动冲突」这类要问人的情况，
 * 调它以「需要确认 + 问题」结束，交回调用方。按**角色**给（docs/26 §3.6）：每个被调用的 agent 都有、入口 agent 没有，不属于任何技能、不受白名单影响；
 * 必须单独调用（同 `load_skill`），调了这一批就提前结束（`terminate`），被调用的 agent 随之收尾。
 */
export function createRequestConfirmationTool(onRequest: (question: string) => void): AgentTool<typeof confirmParams> {
  return {
    name: REQUEST_CONFIRMATION_TOOL_NAME,
    label: '需要确认',
    description:
      '遇到需要确认的情况（要写的节点正被别人修改、和别人的改动冲突、任务说明不清楚等）时调用：以「需要确认」结束这个任务，' +
      '把问题交回给调用你的 agent。必须单独调用（同一次回复里不要再调别的工具）；调用之后你就结束了，不会再收到任何消息。',
    parameters: confirmParams,
    executionMode: 'sequential',
    async execute(_id, args) {
      onRequest(args.question)
      return { content: [{ type: 'text', text: '已交回调用方，等它决定。' }], details: {}, terminate: true }
    },
  }
}

/** 同一批里还有别的工具调用时，runner 拦下 request_confirmation 回给模型的原因 */
export const REQUEST_CONFIRMATION_ALONE_REASON =
  'request_confirmation 必须单独调用：这一批里还有别的工具调用，已拦下它。确实需要确认时，下一次回复只调用 request_confirmation'
