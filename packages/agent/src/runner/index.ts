import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import { AGENT_DELEGATE_TOOL_NAME } from '@shadecn/shared/agent'
import { MAIN_AGENT_ID, runnerEventOf, slimMessage, type SubagentFinishRequest, type SubagentInput } from '../protocol.ts'
import { openLocalSandbox } from '../sandbox/local.ts'
import type { Sandbox } from '../sandbox/types.ts'
import {
  BUILTIN_SKILLS,
  createLoadSkillTool,
  createRequestConfirmationTool,
  definitionContext,
  DELEGATE_SKILL_ID,
  LOAD_SKILL_ALONE_REASON,
  LOAD_SKILL_TOOL_NAME,
  REQUEST_CONFIRMATION_ALONE_REASON,
  REQUEST_CONFIRMATION_TOOL_NAME,
  type SkillContext,
  type SkillRegistry,
} from '../skills/index.ts'
import type { CanvasTool } from '../tools.ts'
import {
  createGatewayClient,
  createUplink,
  GatewayUnauthorizedError,
  type GatewayClient,
  type Uplink,
} from './client.ts'
import { runnerStreamFn } from './stream.ts'

export { GatewayUnauthorizedError, RunnerProtocolMismatchError } from './client.ts'

/**
 * runner：沙箱里跑的那一半（docs/22 §4）—— pi 的推理循环搬到这里，服务端只剩编排、画布与判权。
 *
 * ## 它有什么
 *
 * 网关地址、一次性 bootstrap token、工作目录、`PATH`。**没有** LLM key、数据库、会话密钥、Redis，
 * 也不认识 Y.Doc：工具按技能从同一份注册表（`skills/`）构造 —— 网关执行的工具（`execution: 'gateway'`）是网关 RPC 的代理
 * （参数 schema / 描述来自同一份定义，执行在服务端），模型请求经网关的模型代理（`apiKey` 是 run 短令牌，真实 key 由网关注入）。
 * 只有 runner 执行的工具（`execution: 'runner'`，如 `run_media_command`）在本地跑 —— runner 自己就是沙箱，命令跑在自己的工作目录里，
 * 白名单 / 参数检查 / 超时 / 输出上限沿用 `sandbox/local.ts`。工作目录只在提供的技能里有人要 `sandbox:exec` 时才开。
 *
 * ## 按需加载技能（docs/23 §3.3）
 *
 * pi 的 `Agent` 在每次 `prompt()` / `continue()` 开始时对 `state.tools` 拍快照，循环中途改不生效。所以：
 * - `load_skill` 必须单独成批：`beforeToolCall` 看同一条 assistant 消息，还有别的工具调用就拦下它（别的照常执行）；
 * - 网关加载成功时回 `terminate: true` + `details.loadedSkill`：这一批全是它，pi 提前结束循环、`prompt()` / `continue()` 返回；
 * - 返回后有新加载的技能，就把它的工具并进 `agent.state.tools` 再 `continue()`（可能多次；服务端每轮最多放行 3 次）；
 * - 加载了技能的那一批的 `turn_end` **不 steer**：否则 pi 会带着旧工具立刻再请求一次模型，新工具就落空了。
 *   那些改动留在服务端，下一批调过工具的 `turn_end` 再取（或进跨轮差异）。
 *
 * ## 它守的规矩（与服务端在进程内跑 pi 时逐条相同）
 *
 * - 工具按模型给的顺序一个一个执行（除了 `delegate_task`，别的工具都是 `executionMode: 'sequential'`）；超过 `maxToolCalls` 的被拦下并告诉模型；
 * - **别人的改动只在一批调过工具的 `turn_end` 里 steer**（pi 紧接着就取 steer 队列、再请求模型）：
 *   先把事件冲完，再向网关要合并好的那一条通知；模型写最终回复（这一步没调工具）时不 steer ——
 *   否则 pi 会为它再请求一次模型；那些改动由服务端留给跨轮差异。
 *   steer 进去的那条消息在 pi 的 `message_end` 里认出来（对象身份），上报时带上 `steerId`，
 *   服务端那时才发 `agent.canvas-change`（docs/20 §3.10.2：模型确实看到了才算交付）；
 * - 每个画布工具调用之前先冲事件：旁观者先看到 TOOL_CALL_START，再看到画布上的改动。
 *
 * ## 子 agent（docs/20 §3.10.11）
 *
 * 父 agent 的 `delegate_task` 在这里执行：`/agent/delegate` 登记（服务端分配 id、判上限、转交占用、定好它的系统提示和技能），
 * 然后在**同一个进程**里再建一个 pi `Agent`（{@link runLoop}，同一套代理工具，调用带着它的 agent id），**等它做完**，
 * `/agent/finish` 交回、把服务端拼好的结果返回给父 agent。同一批里全是 `delegate_task` 时 pi 并行执行它们（`toolExecution: 'parallel'`，
 * 别的工具一律 `sequential` —— 混批时整批顺序）。子 agent：没有 `delegate`（只有一层）、有 `request_confirmation`（不能问人，以「需要确认」交回）、
 * 不 steer（别人的改动只插给父 agent）、步数各算（到了就停下它）；工具调用次数全轮共用（`toolCalls` 一个计数）。
 *
 * ## 它不决定的事
 *
 * 一轮的结局（成功 / 中止 / 出错）、步数上限、时长上限、删除预算、补发缓冲、落库 —— 全在服务端。
 * 被中止 / 失权 / 超时时服务端作废令牌并杀掉沙箱，runner 来不及也不需要收尾。
 */

export interface RunnerOptions {
  /** 网关地址（含 `AGENT_GATEWAY_PATH`） */
  gatewayUrl: string
  bootstrapToken: string
  /** 这一轮的工作目录 */
  workdir: string
  /** ffmpeg / ffprobe 的查找路径 */
  pathEnv?: string
  /** 进程内驱动的「杀」：掐掉即中止 pi、中断在途请求 */
  signal?: AbortSignal
  /** 打网关用的 fetch；不给用调用那一刻的 `globalThis.fetch`（模型请求走 pi 的 SDK，用的总是全局 fetch） */
  fetch?: typeof fetch
  /** **测试专用**：覆盖报给网关的协议版本（`null` = 不带，模拟老镜像）；生产不给 */
  protocolVersion?: number | null
  /** **测试专用**：覆盖报给网关的构建 id；生产不给（用编译期注入的） */
  buildId?: string
  /** **测试专用**：技能注册表（必须和服务端那份是同一个）；生产不给（用内置的 `BUILTIN_SKILLS`） */
  skills?: SkillRegistry
}

/**
 * 网关执行的工具的代理：同一份定义，执行 = 一次 `/canvas/tool`。
 * `onLoaded`：网关回报「加载了一个技能」（只有 `load_skill` 会）时调。
 */
function remoteTool(
  tool: CanvasTool,
  client: GatewayClient,
  uplink: Uplink,
  agentId: string,
  executionMode: 'sequential' | 'parallel',
  onLoaded?: (skillId: string) => void,
): AgentTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    executionMode,
    async execute(toolCallId, args) {
      await uplink.flush()
      // 子 agent 的调用带上它的 id（占用、「改过」、步数按 agent 分开）；父 agent 的不带
      const reply = await client.tool({ toolCallId, name: tool.name, args, ...(agentId === MAIN_AGENT_ID ? {} : { agentId }) })
      // 服务端的报错原样交给 pi：它变成 isError 的工具结果回给模型，和在进程内抛出时一样
      if (reply.isError) throw new Error(reply.message)
      if (reply.details.loadedSkill) onLoaded?.(reply.details.loadedSkill)
      return { content: reply.content, details: reply.details, ...(reply.terminate ? { terminate: true } : {}) }
    },
  }
}

/** 一个 agent 循环（父 agent 或一个子 agent）要的东西 */
interface LoopSpec {
  agentId: string
  systemPrompt: string
  messages: AgentMessage[]
  prompt: string
  /** 一开始就加载的技能 */
  loaded: readonly string[]
  /** 造工具用的上下文：父 agent 的带 `delegate`，子 agent 的不带 */
  context: SkillContext
  /** 父 agent：在一批调过工具的 turn_end 取别人的改动 steer 进去；子 agent 从不 steer（docs/20 §3.10.11） */
  main: boolean
  /** 平台给的额外工具（子 agent 的 `request_confirmation`） */
  extraTools: AgentTool[]
  /** 子 agent 自己的步数上限；到了就停下它（服务端另外按上报的 turn_end 数） */
  maxTurns?: number
  signal?: AbortSignal
}

interface LoopResult {
  agent: Agent
  /** 已经上报过的 message_end 条数（不含 pi 自己的 system 消息） */
  ended: number
  /** 构造后 transcript 的长度：带进来的历史 + pi 补在开头的那条 system 消息（系统提示 + 初始工具表） */
  base: number
  /** 步数用完、被 runner 停下的（只有子 agent 会） */
  exhausted: boolean
}

/** 同一批里还有别的工具调用时要拦下的「必须单独调用」的平台工具 */
const ALONE: Record<string, string> = {
  [LOAD_SKILL_TOOL_NAME]: LOAD_SKILL_ALONE_REASON,
  [REQUEST_CONFIRMATION_TOOL_NAME]: REQUEST_CONFIRMATION_ALONE_REASON,
}

const textOf = (message: AgentMessage | undefined): string =>
  message && message.role === 'assistant'
    ? message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('')
        .trim()
    : ''

export async function runAgentRunner(options: RunnerOptions): Promise<void> {
  const client = createGatewayClient({
    baseUrl: options.gatewayUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.protocolVersion !== undefined ? { protocolVersion: options.protocolVersion } : {}),
    ...(options.buildId !== undefined ? { buildId: options.buildId } : {}),
  })
  await client.redeem(options.bootstrapToken)
  const input = await client.input()
  const uplink = createUplink(client)
  let sandbox: Sandbox | null = null

  try {
    const registry = options.skills ?? BUILTIN_SKILLS
    const offered = new Set(input.skills.offered)
    // 提供的技能里有人要在沙箱里执行命令：开这一轮的工作目录，写进服务端准备的文件
    const needsSandbox = input.skills.offered.some((id) => registry.get(id)?.requires.includes('sandbox:exec'))
    if (needsSandbox) {
      sandbox = await openLocalSandbox(options.workdir, options.pathEnv ? { pathEnv: options.pathEnv } : {})
      for (const [file, content] of Object.entries(input.files)) await sandbox.writeFile(file, content)
    }

    /** 全轮共用的工具调用计数：父 agent 和全部子 agent 加起来（docs/20 §3.10.11「预算」；网关另按同一个数硬拦） */
    let toolCalls = 0

    /** 一个技能在这个 agent 里的工具：网关工具包成代理；`delegate_task` 并行、其余一律顺序（混批整批顺序，见技能 `delegate`） */
    const toolsOf = (id: string, spec: LoopSpec): AgentTool[] => {
      const skill = registry.get(id)
      if (!skill) return []
      return skill.tools(spec.context).map((tool) => {
        const mode = tool.name === AGENT_DELEGATE_TOOL_NAME ? 'parallel' : 'sequential'
        return tool.execution === 'runner' ? { ...(tool as AgentTool), executionMode: mode } : remoteTool(tool, client, uplink, spec.agentId, mode)
      })
    }

    async function runLoop(spec: LoopSpec): Promise<LoopResult> {
      /** 已经并进 pi 的技能 */
      const loaded = new Set<string>()
      /** 网关说加载成功了、还没并进 pi 的技能（这一批结束、循环返回后再并） */
      const pending: string[] = []
      const onLoaded = (id: string) => {
        // 子 agent 不能有 delegate（只有一层）：网关本来就不给它加载，这里再挡一次
        if (!spec.main && id === DELEGATE_SKILL_ID) return
        if (offered.has(id) && !loaded.has(id) && !pending.includes(id)) pending.push(id)
      }
      const tools: AgentTool[] = [
        remoteTool(createLoadSkillTool(), client, uplink, spec.agentId, 'sequential', onLoaded),
        ...spec.extraTools.map((tool) => ({ ...tool, executionMode: 'sequential' as const })),
      ]
      for (const id of spec.loaded) {
        if (loaded.has(id) || (!spec.main && id === DELEGATE_SKILL_ID)) continue
        loaded.add(id)
        tools.push(...toolsOf(id, spec))
      }

      /** steer 进去、还没被 pi 放进上下文的那条消息 → 通知 id */
      const steered = new Map<AgentMessage, string>()
      const agent = new Agent({
        initialState: {
          systemPrompt: spec.systemPrompt,
          model: { ...input.model, baseUrl: client.llmBaseUrl },
          thinkingLevel: 'off',
          tools,
          messages: spec.messages,
        },
        // 三种线协议直接分派（pi 1.x 起必填），见 stream.ts
        streamFn: runnerStreamFn,
        // 交给 SDK 的「key」是 run 短令牌（快过期时先续期）；网关的模型代理每次请求都判 llm:invoke
        getApiKey: () => client.token(),
        // 并行只给 delegate_task：别的工具都标了 sequential，一批里只要有一个就整批顺序执行（pi 的规则，1.4 仍然如此）
        toolExecution: 'parallel',
        steeringMode: 'all',
        beforeToolCall: async ({ toolCall, assistantMessage }) => {
          toolCalls += 1
          if (toolCalls > input.limits.maxToolCalls) {
            return { block: true, reason: `本轮工具调用已达上限 ${input.limits.maxToolCalls} 次，请停止并向用户说明进度` }
          }
          // pi 只在一批结果**全部** terminate 时提前结束：和别的工具同批的 load_skill / request_confirmation 拦下（别的照常执行）
          const alone = ALONE[toolCall.name]
          if (alone && assistantMessage.content.some((part) => part.type === 'toolCall' && part.name !== toolCall.name)) {
            return { block: true, reason: alone }
          }
          return undefined
        },
      })
      const stop = () => agent.abort()
      spec.signal?.addEventListener('abort', stop, { once: true })

      let ended = 0
      let turns = 0
      let exhausted = false
      const base = agent.state.messages.length
      agent.subscribe(async (event) => {
        // pi 自己的 system 消息（load_skill 之后续上的 `toolsAdded`）只给模型看：不上报、不计数（runnerEventOf 同样丢掉）
        if (event.type === 'message_end' && event.message.role === 'system') return
        if (event.type === 'message_end') ended += 1
        const slim = runnerEventOf(event, (message) => steered.get(message))
        // 子 agent 的事件带上它的 id：服务端据此归到它的子任务条目，不进父 agent 的上下文
        if (slim) uplink.push(spec.main ? slim : { ...slim, agentId: spec.agentId })
        if (event.type === 'message_end' && event.message.role === 'user') steered.delete(event.message)
        if (event.type !== 'turn_end') return
        // 一批结束：先把事件冲完（服务端在这里数步数，超了当场叫停）
        await uplink.flush()
        if (!spec.main) {
          // 子 agent：步数到了就停下它（还要再请求模型的时候）；别人的改动不插给它，它靠「改过」检查发现
          turns += 1
          if (spec.maxTurns !== undefined && turns >= spec.maxTurns && event.toolResults.length > 0) {
            exhausted = true
            agent.abort()
          }
          return
        }
        // 最后一次回复（没调工具）之后不 steer：pi 会为它再请求一次模型
        if (event.toolResults.length === 0) return
        // 这一批加载了技能：循环要在这里结束、并进新工具再继续；steer 会让 pi 带着旧工具接着请求模型
        if (pending.length > 0) return
        const { change } = await client.changes()
        if (!change) return
        const message: AgentMessage = { role: 'user', content: change.text, timestamp: Date.now() }
        steered.set(message, change.id)
        agent.steer(message)
      })

      try {
        if (!spec.signal?.aborted) await agent.prompt(spec.prompt)
        // 这一批以 load_skill 提前结束：并进新技能的工具，接着跑（可能多次）。被中止 / 出错收尾的不再继续
        while (
          pending.length > 0 &&
          !spec.signal?.aborted &&
          !exhausted &&
          agent.state.messages.at(-1)?.role === 'toolResult'
        ) {
          for (const id of pending.splice(0)) {
            if (loaded.has(id)) continue
            loaded.add(id)
            agent.state.tools = [...agent.state.tools, ...toolsOf(id, spec)]
          }
          await agent.continue()
        }
      } finally {
        spec.signal?.removeEventListener('abort', stop)
      }
      return { agent, ended, exhausted, base }
    }

    /** 跑一个子 agent 到结束，判它怎么结束的（服务端可能改判） */
    async function runSubagent(sub: SubagentInput, signal: AbortSignal): Promise<Omit<SubagentFinishRequest, 'agentId'>> {
      let question: string | null = null
      const confirm = createRequestConfirmationTool((text) => {
        question ??= text
      }) as unknown as AgentTool
      try {
        const result = await runLoop({
          agentId: sub.agentId,
          systemPrompt: sub.systemPrompt,
          messages: [],
          prompt: sub.prompt,
          loaded: sub.skills.loaded,
          // 子 agent 的上下文没有 delegate：就算拿到了 delegate_task 的定义，一调也报错
          context: definitionContext('runner', sandbox ?? undefined),
          main: false,
          extraTools: [confirm],
          maxTurns: sub.limits.maxTurns,
          signal,
        })
        const last = [...result.agent.state.messages].reverse().find((message) => message.role === 'assistant')
        const text = textOf(last)
        const asked = question as string | null
        if (asked !== null) return { status: 'needs_confirmation', text, question: asked, error: null }
        if (result.exhausted) return { status: 'failed', text, question: null, error: `超过子任务的步数上限 ${sub.limits.maxTurns}` }
        if (last?.role === 'assistant' && last.stopReason === 'error') {
          return { status: 'failed', text, question: null, error: last.errorMessage || '模型调用失败' }
        }
        if (signal.aborted || (last?.role === 'assistant' && last.stopReason === 'aborted')) {
          return { status: 'failed', text, question: null, error: '已中止' }
        }
        return { status: 'done', text, question: null, error: null }
      } catch (err) {
        return { status: 'failed', text: '', question: null, error: err instanceof Error ? err.message : String(err) }
      }
    }

    /**
     * 父 agent 的 `delegate_task`（docs/20 §3.10.11）：网关登记 → 同一进程里跑子 agent → 交回结果。
     * 阻塞到子 agent 做完；同一批的几个在 pi 的并行工具执行里同时跑。父 agent 被停（它的 signal）或整轮被杀时子 agent 一起停。
     */
    const delegate: NonNullable<SkillContext['delegate']> = async (toolCallId, args, signal) => {
      // 先让服务端看到这次 delegate_task 的 TOOL_CALL_START（它据此认这次派发）
      await uplink.flush()
      const reply = await client.delegate({ agentId: MAIN_AGENT_ID, toolCallId, brief: args.brief, nodeIds: args.nodeIds ?? [] })
      if (!reply.ok) throw new Error(reply.message)
      const controller = new AbortController()
      const abort = () => controller.abort()
      for (const source of [signal, options.signal]) {
        if (source?.aborted) controller.abort()
        source?.addEventListener('abort', abort, { once: true })
      }
      let outcome: Omit<SubagentFinishRequest, 'agentId'>
      try {
        outcome = await runSubagent(reply.agent, controller.signal)
      } finally {
        for (const source of [signal, options.signal]) source?.removeEventListener('abort', abort)
      }
      // 它的事件先冲完（服务端按它们数步数、拼条目），再交回
      await uplink.flush()
      const done = await client.agentFinish({ agentId: reply.agent.agentId, ...outcome })
      if (done.isError) throw new Error(done.text)
      return { content: [{ type: 'text', text: done.text }], details: { summary: done.summary, elementIds: done.changedNodeIds } }
    }

    const main = await runLoop({
      agentId: MAIN_AGENT_ID,
      systemPrompt: input.systemPrompt,
      messages: input.llmMessages,
      prompt: input.prompt,
      loaded: input.skills.loaded,
      context: { ...definitionContext('runner', sandbox ?? undefined), delegate },
      main: true,
      extraTools: [],
      ...(options.signal ? { signal: options.signal } : {}),
    })
    /*
     * 兜底补报：进了 transcript、却没经过 message_end 的消息。pi 0.73 兜住的失败（`handleRunFailure`）就是这样；
     * pi 1.x 改成照常发 message_start / message_end + turn_end（服务端照常把它算一步），所以正常情况下这里什么都不补。
     * 对齐时去掉 pi 的 system 消息：它们不上报，也不在 `ended` 里。
     */
    const unreported = main.agent.state.messages
      .slice(main.base)
      .filter((message) => message.role !== 'system')
      .slice(main.ended)
    for (const message of unreported) {
      uplink.push({ type: 'message_end', message: slimMessage(message) })
    }
    await uplink.flush()
    await client.finish({ error: null })
  } catch (err) {
    // 令牌失效 / 被杀：这一轮已经由服务端收尾，不再报；其余的报一下原因（报不上也无妨，服务端按异常退出收尾）
    if (!(err instanceof GatewayUnauthorizedError) && !options.signal?.aborted) {
      await client.finish({ error: err instanceof Error ? err.message : String(err) }).catch(() => undefined)
    }
    throw err
  } finally {
    await sandbox?.dispose()
  }
}
