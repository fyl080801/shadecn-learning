import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { AGENT_DELEGATE_TOOL_NAME } from '@shadecn/shared/agent'
import { DELEGATE_BRIEF_MAX, DELEGATE_NODE_IDS_MAX } from '../../protocol.ts'
import type { CanvasTool } from '../../tools.ts'
import { defineSkill, REQUEST_CONFIRMATION_TOOL_NAME, type SkillContext } from '../registry.ts'

/**
 * 子任务技能 `delegate`（docs/20 §3.10.11）：父 agent 把一个大任务拆开、并行交给子 agent 做。`always`，**子 agent 里不提供**
 * （只有一层：服务端给子 agent 定技能时排除它，也拒绝子 agent 发起的派发）。
 *
 * `delegate_task` 在 runner 里执行（`execution: 'runner'`）：runner 先经网关登记（服务端分配 id、判上限、转交占用），
 * 再在**同一个进程**里建一个独立的 pi `Agent` 跑子 agent，**等它做完**才返回 —— 子 agent 的每一次模型请求、画布工具调用
 * 都是正常的网关请求（判权、预算照旧），所以它不起子进程，也就不要求 `sandbox:exec`（`spawnsProcess` 不设）。
 *
 * 并行：它是 `executionMode: 'parallel'`，别的工具一律 `sequential`（runner 统一设）；pi 的规则（1.4 仍然如此）是**一批里只要有一个
 * sequential 就整批顺序执行**，所以「同一批全是 delegate_task」才并行，混了别的工具就整批按顺序。
 */

export const DELEGATE_SKILL_ID = 'delegate'

const delegateParams = Type.Object(
  {
    brief: Type.String({
      minLength: 1,
      maxLength: DELEGATE_BRIEF_MAX,
      description: '交给子 agent 的任务说明：要做什么、做到什么程度、有什么约束。子 agent 看不到你和用户的对话，说明要自足',
    }),
    nodeIds: Type.Optional(
      Type.Array(Type.String({ pattern: '^[A-Za-z0-9_-]{1,64}$' }), {
        maxItems: DELEGATE_NODE_IDS_MAX,
        description: '它要处理的节点 id（会作为提及放进它的第一条消息，附上这些节点当前的内容；导演台节点会让它自动加载导演台技能）',
      }),
    ),
  },
  { additionalProperties: false },
)

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

export function createDelegateTool(ctx: SkillContext): CanvasTool<typeof delegateParams> {
  return {
    name: AGENT_DELEGATE_TOOL_NAME,
    // 派发本身只是读：子 agent 的每次写都按各自工具的能力在网关上判
    capability: 'flow:read',
    label: '派子任务',
    description:
      '派一个子 agent 去做一件独立的事，等它做完返回它的结果（最终回复摘要和它改过的节点）。' +
      '要并行做几件互不相干的事时，在同一次回复里调用多次 delegate_task（同一批全是它才会并行）；' +
      '子 agent 不能再派子任务，也不能直接问用户：需要确认时它会交回一个问题，由你决定怎么办。',
    parameters: delegateParams,
    execution: 'runner',
    executionMode: 'parallel',
    describe: (args) => `子任务：${clip(args.brief.replace(/\s+/g, ' '), 60)}`,
    async execute(toolCallId, args, signal) {
      if (!ctx.delegate) throw new Error('delegate_task 只能由父 agent 在 runner 里执行')
      return ctx.delegate(toolCallId, args, signal)
    },
  }
}

export const delegateSkill = defineSkill({
  id: DELEGATE_SKILL_ID,
  title: '子任务',
  summary: '把大任务拆成几个独立的子任务，派子 agent 并行执行，等它们做完拿回结果摘要',
  prompt: `- delegate_task({ brief, nodeIds? }) 派一个子 agent 去做一件独立的事，**等它做完**才返回：结果里是它的最终回复（摘要）和它改过的节点，不含它的过程。
- 什么时候用：任务能拆成几件**互不相干**的事（例如「分别给这三个导演台各搭一个场景」），或某一步要读写大量内容、会把你的上下文撑满（场景数据、测量结果）。一两步就能做完的事自己做，不要派。
- 并行：要同时做的几件事，在**同一次回复里**各调一次 delegate_task（这一批只放 delegate_task，混进别的工具就会按顺序一件件做）。同时最多 3 个，一轮累计最多 10 个，超出会被拒绝。
- brief 要自足：子 agent 看不到你和用户的对话，写清楚要做什么、做到什么程度、不要碰什么；它要处理的节点放进 nodeIds（不要让两个子任务改同一个节点 —— 后写的那个会被拒绝）。
- 你正占用着的节点（你改过它的数据）派给子 agent 时，占用转给它；它结束就释放，你之后要再改得重新占用。
- 子任务失败：结果里有原因，你决定重派、换个做法，还是向用户说明。子任务「需要确认」：它遇到了要问人的情况（节点正被别人修改、和别人的改动冲突……），结果里带着它的问题 —— 由你判断，需要时停下来问用户。`,
  tools: (ctx) => [createDelegateTool(ctx)],
  requires: ['flow:read'],
  activation: 'always',
})

const confirmParams = Type.Object(
  {
    question: Type.String({
      minLength: 1,
      maxLength: 2000,
      description: '要交给父 agent（再由它问用户）的问题：遇到了什么情况、需要谁确认什么',
    }),
  },
  { additionalProperties: false },
)

/**
 * 子 agent 的平台工具「需要确认」：子 agent 不直接问人（docs/20 §3.10.11），遇到「正在被别人修改」「和别人的改动冲突」这类要问人的情况，
 * 调它以「需要确认 + 问题」结束，交回父 agent。只在 runner 里给子 agent（不属于任何技能）；必须单独调用（同 `load_skill`），
 * 调了这一批就提前结束（`terminate`），子 agent 随之收尾。
 */
export function createRequestConfirmationTool(onRequest: (question: string) => void): AgentTool<typeof confirmParams> {
  return {
    name: REQUEST_CONFIRMATION_TOOL_NAME,
    label: '需要确认',
    description:
      '遇到需要用户确认的情况（要写的节点正被别人修改、和别人的改动冲突、任务说明不清楚等）时调用：以「需要确认」结束这个子任务，' +
      '把问题交回给派你来的 agent。必须单独调用（同一次回复里不要再调别的工具）；调用之后你就结束了，不会再收到任何消息。',
    parameters: confirmParams,
    executionMode: 'sequential',
    async execute(_id, args) {
      onRequest(args.question)
      return { content: [{ type: 'text', text: '已交回父 agent，等它决定。' }], details: {}, terminate: true }
    },
  }
}

/** 同一批里还有别的工具调用时，runner 拦下 request_confirmation 回给模型的原因 */
export const REQUEST_CONFIRMATION_ALONE_REASON =
  'request_confirmation 必须单独调用：这一批里还有别的工具调用，已拦下它。确实需要确认时，下一次回复只调用 request_confirmation'
