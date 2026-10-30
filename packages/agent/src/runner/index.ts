import { Agent, type AgentContext, type AgentLoopTurnUpdate, type AgentMessage, type AgentTool, type AgentTurnDecision } from '@earendil-works/pi-agent-core'
import { contentText } from '@earendil-works/pi-ai'
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
 * pi 的 `Agent` 在每次 `prompt()` / `continue()` 开始时对 `state.tools` 拍快照，循环中途改 `state.tools` 不生效；
 * 改下一次请求的工具表只能经 pi 的 `prepareNextTurnWithContext`（一批工具执行完、循环要接着请求模型之前调）。所以：
 * - `load_skill` 必须单独成批：`beforeToolCall` 看同一条 assistant 消息，还有别的工具调用就拦下它（别的照常执行）；
 * - 网关加载成功时回 `details.loadedSkill`（服务端照旧带 `terminate: true`，给老镜像用；这里的代理把它剥掉，循环不在这一批结束）；
 * - `prepareNextTurnWithContext` 里把新加载的技能的工具并进返回的 `context.tools`（pi 据此在下一次请求前补一条 `toolsAdded`
 *   的 system 消息），同时写回 `agent.state.tools` —— 否则之后哪次 `continue()` 按旧快照拍工具表，pi 会宣布这些工具被移除了。
 *   服务端每轮最多放行 3 次加载。
 *
 * ## 它守的规矩（与服务端在进程内跑 pi 时逐条相同）
 *
 * - 工具按模型给的顺序一个一个执行（除了 `delegate_task`，别的工具都是 `executionMode: 'sequential'`）；超过 `maxToolCalls` 的被拦下并告诉模型；
 * - **别人的改动只在 `prepareNextTurnWithContext` 里交**：pi 只在循环确实要再请求模型时调它（一批工具执行完之后；
 *   最终回复没调工具、循环就此结束时不调），所以「写最终回复时不插通知、不为它多请求一次模型」是结构保证。
 *   `turn_end` 里先把事件冲完，钩子里再向网关要合并好的那一条通知，作为钩子返回的 `messages` 交给 pi
 *   （和新加载的工具在同一个钩子里：加载技能的那一批也照常交付）；没交出去的由服务端留给跨轮差异。
 *   pi 把返回的消息原对象走 `message_start` / `message_end`，所以在 `message_end` 里按对象身份认出来，上报时带上 `steerId`，
 *   服务端那时才发 `agent.canvas-change`（docs/20 §3.10.2：模型确实看到了才算交付）。钩子里抛错和 `turn_end` 监听器抛错
 *   一样，走 pi 的 `handleRunFailure`（补一条出错的 assistant 消息 + `turn_end`）；
 * - 每个画布工具调用之前先冲事件：旁观者先看到 TOOL_CALL_START，再看到画布上的改动。
 *
 * ## 子 agent（docs/20 §3.10.11）
 *
 * 父 agent 的 `delegate_task` 在这里执行：`/agent/delegate` 登记（服务端分配 id、判上限、转交占用、定好它的系统提示和技能），
 * 然后在**同一个进程**里再建一个 pi `Agent`（{@link runLoop}，同一套代理工具，调用带着它的 agent id），**等它做完**，
 * `/agent/finish` 交回、把服务端拼好的结果返回给父 agent。同一批里全是 `delegate_task` 时 pi 并行执行它们（`toolExecution: 'parallel'`，
 * 别的工具一律 `sequential` —— 混批时整批顺序）。子 agent：没有 `delegate`（只有一层）、有 `request_confirmation`（不能问人，以「需要确认」交回）、
 * 不取别人的改动（只插给父 agent）、步数各算（到了由 pi 的 `finishTurn` 结束它的循环）；工具调用次数全轮共用（`toolCalls` 一个计数）。
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
      // load_skill 的 terminate 是给老镜像的（它们靠提前结束这一批再 continue）：这里在 prepareNextTurnWithContext 里并进新工具，剥掉
      const terminate = reply.terminate === true && tool.name !== LOAD_SKILL_TOOL_NAME
      return { content: reply.content, details: reply.details, ...(terminate ? { terminate: true } : {}) }
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
  /** 父 agent：循环要接着请求模型之前（prepareNextTurnWithContext）取别人的改动交进去；子 agent 从不取（docs/20 §3.10.11） */
  main: boolean
  /** 平台给的额外工具（子 agent 的 `request_confirmation`） */
  extraTools: AgentTool[]
  /** 子 agent 自己的步数上限；到了由 `finishTurn` 结束它的循环（服务端另外按上报的 turn_end 数） */
  maxTurns?: number
  signal?: AbortSignal
}

interface LoopResult {
  agent: Agent
  /** 已经上报过的 message_end 条数（不含 pi 自己的 system 消息） */
  ended: number
  /** 构造后 transcript 的长度：带进来的历史 + pi 补在开头的那条 system 消息（系统提示 + 初始工具表） */
  base: number
  /** 步数用完、被 runner 结束的（只有子 agent 会） */
  exhausted: boolean
}

/** 同一批里还有别的工具调用时要拦下的「必须单独调用」的平台工具 */
const ALONE: Record<string, string> = {
  [LOAD_SKILL_TOOL_NAME]: LOAD_SKILL_ALONE_REASON,
  [REQUEST_CONFIRMATION_TOOL_NAME]: REQUEST_CONFIRMATION_ALONE_REASON,
}

const textOf = (message: AgentMessage | undefined): string =>
  message && message.role === 'assistant' ? contentText(message.content, '').trim() : ''

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
      /** 网关说加载成功了、还没并进 pi 的技能（这一批执行完、下一次请求之前在 prepareNextTurnWithContext 里并） */
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

      /** 交给 pi、还没被它放进上下文的那条通知消息 → 通知 id */
      const steered = new Map<AgentMessage, string>()
      const maxTurns = spec.maxTurns
      let turns = 0
      let exhausted = false
      const agent: Agent = new Agent({
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
        beforeToolCall: async ({ toolCall, assistantMessage }) => {
          toolCalls += 1
          if (toolCalls > input.limits.maxToolCalls) {
            return { block: true, reason: `本轮工具调用已达上限 ${input.limits.maxToolCalls} 次，请停止并向用户说明进度` }
          }
          // 和别的工具同批的这两个拦下（别的照常执行）。load_skill：docs/23 S4 要它单独成批（同批的别的调用是模型读到技能说明之前定的）；
          // request_confirmation：pi 只在一批结果**全部** terminate 时提前结束
          const alone = ALONE[toolCall.name]
          if (alone && assistantMessage.content.some((part) => part.type === 'toolCall' && part.name !== toolCall.name)) {
            return { block: true, reason: alone }
          }
          return undefined
        },
        /*
         * 子 agent 的步数上限：pi 在一步的结果都进了上下文、发 turn_end 之前调它。到了上限、这一步还调了工具（还要再请求模型）
         * → `end`：pi 不再请求模型、照常发 turn_end + agent_end，prompt() 正常返回（不多一次被掐断的请求，最后一条 assistant 是真回复）。
         * 出错 / 被中止的那一步 pi 也调它（返回值不看），照样计一步。父 agent 不设（它的上限只在服务端）。
         */
        ...(maxTurns !== undefined
          ? {
              finishTurn: ({ toolResults }): AgentTurnDecision | undefined => {
                turns += 1
                if (turns < maxTurns || toolResults.length === 0) return undefined
                exhausted = true
                return { action: 'end' }
              },
            }
          : {}),
        /*
         * 循环要接着请求模型之前（一批工具执行完、turn_end 之后；最终回复之后不调）：
         * 1. 并进这一批里新加载的技能的工具（返回的 `context.tools` 是下一次请求用的；`agent.state.tools` 同步写回）；
         * 2. 父 agent：向网关要合并好的画布改动通知（turn_end 里已经冲完事件），作为 `messages` 交给 pi ——
         *    pi 把它们（同一对象）走 message_start / message_end 再追加进上下文，排在 `toolsAdded` 那条 system 消息之后。
         */
        prepareNextTurnWithContext: async ({ context }): Promise<AgentLoopTurnUpdate | undefined> => {
          const added: AgentTool[] = []
          for (const id of pending.splice(0)) {
            if (loaded.has(id)) continue
            loaded.add(id)
            added.push(...toolsOf(id, spec))
          }
          let next: AgentContext | undefined
          if (added.length > 0) {
            const merged = [...(context.tools ?? []), ...added]
            agent.state.tools = merged
            // 同一个 messages 数组（pi 接着往里追加），只换工具表
            next = { ...context, tools: merged }
          }
          let messages: AgentMessage[] | undefined
          if (spec.main) {
            const { change } = await client.changes()
            if (change) {
              const message: AgentMessage = { role: 'user', content: change.text, timestamp: Date.now() }
              steered.set(message, change.id)
              messages = [message]
            }
          }
          if (!next && !messages) return undefined
          return { ...(next ? { context: next } : {}), ...(messages ? { messages } : {}) }
        },
      })
      const stop = () => agent.abort()
      spec.signal?.addEventListener('abort', stop, { once: true })

      let ended = 0
      const base = agent.state.messages.length
      agent.subscribe(async (event) => {
        // pi 自己的 system 消息（load_skill 之后续上的 `toolsAdded`）只给模型看：不上报、不计数（runnerEventOf 同样丢掉）
        if (event.type === 'message_end' && event.message.role === 'system') return
        if (event.type === 'message_end') ended += 1
        const slim = runnerEventOf(event, (message) => steered.get(message))
        // 子 agent 的事件带上它的 id：服务端据此归到它的子任务条目，不进父 agent 的上下文
        if (slim) uplink.push(spec.main ? slim : { ...slim, agentId: spec.agentId })
        if (event.type === 'message_end' && event.message.role === 'user') steered.delete(event.message)
        // 一批结束：先把事件冲完（服务端在这里数步数，超了当场叫停；接着 prepareNextTurnWithContext 才去取画布改动）
        if (event.type === 'turn_end') await uplink.flush()
      })

      try {
        if (!spec.signal?.aborted) await agent.prompt(spec.prompt)
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
