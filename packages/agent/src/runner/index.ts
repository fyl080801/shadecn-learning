import {
  Agent,
  streamProxy,
  type AgentLoopTurnUpdate,
  type AgentTool,
  type AgentTurnDecision,
  type StreamFn,
} from '@earendil-works/pi-agent-core'
import { normalizeContext } from '@earendil-works/pi-ai'
import { AGENT_RUN_TOOL_NAME } from '@shadecn/shared/agent'
import { ENTRY_AGENT_ID, runnerEventOf, type RunnerAgentSpec } from '../protocol.ts'
import { openLocalSandbox } from '../sandbox/local.ts'
import type { Sandbox } from '../sandbox/types.ts'
import {
  AGENTS_SKILL_ID,
  BUILTIN_SKILLS,
  createLoadSkillTool,
  createRequestConfirmationTool,
  definitionContext,
  REQUEST_CONFIRMATION_ALONE_REASON,
  REQUEST_CONFIRMATION_TOOL_NAME,
  toolCallLimitReason,
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

export { GatewayUnauthorizedError, RunnerProtocolMismatchError } from './client.ts'

/**
 * runner：沙箱里跑的那一半（docs/22 §4）—— pi 的推理循环搬到这里，服务端只剩编排、画布与判权。
 *
 * ## 它有什么
 *
 * 网关地址、一次性 bootstrap token、工作目录、`PATH`。**没有** LLM key、数据库、会话密钥、Redis，
 * 也不认识 Y.Doc：工具按技能从同一份注册表（`skills/`）构造 —— 网关执行的工具（`execution: 'gateway'`）是网关 RPC 的代理
 * （参数 schema / 描述来自同一份定义，执行在服务端），模型请求经 pi 的 `streamProxy` 交给网关（`authToken` 是 run 短令牌）：
 * 服务端用自己的 transcript、自己解析的模型、参数和真实 key 调上游，把事件流发回来（docs/22 §4.3）——
 * runner **只送空的上下文**，送去的模型、参数一概不用。所以 runner 也拿不到系统提示、提示词和之前几轮的上下文（第 7 版起不给）：
 * 这里 pi 的 transcript 只有服务端发回来的回复和这里执行出来的工具结果，只用来驱动循环（按回复执行工具、决定要不要再请求）。
 * 只有 runner 执行的工具（`execution: 'runner'`，如 `run_media_command`）在本地跑 —— runner 自己就是沙箱，命令跑在自己的工作目录里，
 * 白名单 / 参数检查 / 超时 / 输出上限沿用 `sandbox/local.ts`。工作目录只在提供的技能里有人要 `sandbox:exec` 时才开。
 *
 * ## 按需加载技能（docs/23 §3.3）
 *
 * pi 的 `Agent` 在每次 `prompt()` / `continue()` 开始时对 `state.tools` 拍快照，循环中途改 `state.tools` 不生效；
 * 改下一次请求的工具表只能经 pi 的 `prepareNextTurnWithContext`（一批工具执行完、循环要接着请求模型之前调）。所以：
 * - 网关加载成功时回 `details.loadedSkills`（新加载的内置技能 id；加载一个文字技能时是它依赖、一起加载的那几个，runner 不认识文字技能）；`load_skill` 必须单独成批由**网关**判（同批还有别的调用就拒，回给模型的就是那句话），这里不拦；
 * - `prepareNextTurnWithContext` 里把新加载的技能的工具并进返回的 `context.tools`（pi 按新工具表执行下一批调用），
 *   同时写回 `agent.state.tools` —— 否则之后哪次 `continue()` 按旧快照拍工具表，pi 会宣布这些工具被移除了。
 *   模型看到的「新工具」是服务端在它的 transcript 里插的 `toolsAdded`，不是这里的。服务端每轮最多放行 3 次加载。
 *
 * ## 它守的规矩
 *
 * - 工具按模型给的顺序一个一个执行（除了 `run_agent`，别的工具都是 `executionMode: 'sequential'`）；
 * - **拦截只剩到不了网关的那两种**（`beforeToolCall`，docs/22 §4.3 第 4 步）：`request_confirmation` 没单独调用；
 *   runner 执行的命令超过 `maxToolCalls`（计数和服务端同一个口径：除了 `request_confirmation` 的每次调用都计）。
 *   网关执行的工具（含 `run_agent`、`load_skill`）的工具调用上限、单独调用都由网关在调用到达时判，这里照常发过去；
 * - 每个画布工具调用、每次模型请求之前先冲事件：旁观者先看到条目再看到画布上的改动，服务端在下一次请求时补齐上一批的结果
 *   （runner 执行的工具的结果取上报的）之前已经收到了它们。别人的改动通知不经这里：服务端在入口 agent 的下一次模型请求时直接插进它的 transcript。
 *
 * ## 被调用的 agent（docs/20 §3.10.11、docs/26 §3.5）
 *
 * 调用方的 `run_agent` 在这里执行：`/agent/task/start` 登记（服务端分配 id、判调用深度与上限、转交占用、按被调用的 agent **自己的定义**
 * 定好它的系统提示、技能、工具白名单和模型），然后在**同一个进程**里再建一个 pi `Agent`（{@link runLoop}，同一套代理工具，调用带着它的 agent id），
 * **等它做完**，`/agent/task/finish` 交回、把服务端拼好的结果返回给调用方。任何 agent 都可以是调用方：它的技能里有 `agents`
 * （深度没到上限、白名单里有 `run_agent`）时，它的上下文里才有 `runAgent`，被调用的 agent 再发起的任务同样嵌套在这里跑。
 * 同一批里全是 `run_agent` 时 pi 并行执行它们（`toolExecution: 'parallel'`，别的工具一律 `sequential` —— 混批时整批顺序）。
 * 被调用的 agent：有 `request_confirmation`（不能问人，以「需要确认」交回）、步数各算（到了由 pi 的 `finishTurn` 结束它的循环）；
 * 工具调用次数全轮共用（`toolCalls` 一个计数）。每个 agent 的工具表按它自己的白名单滤（{@link RunnerAgentSpec.tools}）。
 * 它怎么结束的（完成 / 失败 / 需要确认）、回复文字全由服务端按它的 transcript 判，`/agent/task/finish` 只报「结束了」。
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
 * `onLoaded`：网关回报「加载了内置技能」（只有 `load_skill` 会，可能一次几个）时对每个调一次。
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
      // 被调用的 agent 的调用带上它的 id（占用、「改过」、步数按 agent 分开）；入口 agent 的不带
      const reply = await client.tool({ toolCallId, name: tool.name, args, ...(agentId === ENTRY_AGENT_ID ? {} : { agentId }) })
      // 服务端的报错原样交给 pi：它变成 isError 的工具结果回给模型，和在进程内抛出时一样
      if (reply.isError) throw new Error(reply.message)
      for (const id of reply.details.loadedSkills ?? []) onLoaded?.(id)
      return { content: reply.content, details: reply.details }
    },
  }
}

/** 一个 agent 循环（入口 agent 或一个被调用的 agent）要的东西 */
interface LoopSpec {
  agentId: string
  /** 服务端按它的定义定好的：技能、工具白名单、模型 */
  agent: RunnerAgentSpec
  /** 入口 agent（事件、工具调用不带 agent id） */
  entry: boolean
  /** 平台给的额外工具（被调用的 agent 的 `request_confirmation`） */
  extraTools: AgentTool[]
  /** 被调用的 agent 自己的步数上限；到了由 `finishTurn` 结束它的循环（服务端另外按模型请求数硬拦） */
  maxTurns?: number
  signal?: AbortSignal
}

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
    // 这一轮提供的技能（全部可能跑起来的 agent 的并）里有人要在沙箱里执行命令：开这一轮的工作目录，写进服务端准备的文件
    const needsSandbox = input.offered.some((id) => registry.get(id)?.requires.includes('sandbox:exec'))
    if (needsSandbox) {
      sandbox = await openLocalSandbox(options.workdir, options.pathEnv ? { pathEnv: options.pathEnv } : {})
      for (const [file, content] of Object.entries(input.files)) await sandbox.writeFile(file, content)
    }

    /**
     * 全轮共用的工具调用计数：调用方和全部被调用的 agent 加起来（docs/20 §3.10.11「预算」），口径同服务端（除了 `request_confirmation` 都计）。
     * 只用来拦 runner 执行的命令（{@link localCommands}）：网关执行的到网关由服务端的计数判
     */
    let toolCalls = 0
    /** runner 自己执行、到不了网关的命令（`execution: 'runner'`，`run_agent` 除外 —— 它经 `/agent/task/start`，由网关计数） */
    const localCommands = new Set<string>()

    /**
     * 一个技能在这个 agent 里的工具：**按它定义的白名单滤**（docs/26 §3.3；runner 执行的工具到不了网关，只能在这里不给 pi），
     * 网关工具包成代理；`run_agent` 并行、其余一律顺序（混批整批顺序，见技能 `agents`）
     */
    const toolsOf = (id: string, spec: LoopSpec, context: SkillContext): AgentTool[] => {
      const skill = registry.get(id)
      if (!skill) return []
      const allowed = spec.agent.tools === null ? null : new Set(spec.agent.tools)
      return skill
        .tools(context)
        .filter((tool) => allowed === null || allowed.has(tool.name))
        .map((tool) => {
          const mode = tool.name === AGENT_RUN_TOOL_NAME ? 'parallel' : 'sequential'
          if (tool.execution !== 'runner') return remoteTool(tool, client, uplink, spec.agentId, mode)
          if (tool.name !== AGENT_RUN_TOOL_NAME) localCommands.add(tool.name)
          return { ...(tool as AgentTool), executionMode: mode }
        })
    }

    async function runLoop(spec: LoopSpec): Promise<Agent> {
      /** 这个 agent 能加载的技能（服务端按它的定义与调用深度定的；网关说加载成功的也只认这些） */
      const offered = new Set(spec.agent.skills.offered)
      /**
       * 造工具用的上下文：可调用的 agent 目录（`run_agent` 的 enum 与描述，和服务端同一份）；
       * 它能调用别的 agent（技能里有 `agents`）才给 `runAgent`，发起时带着它自己的 id
       */
      const skillContext: SkillContext = {
        ...definitionContext('runner', sandbox ?? undefined),
        agents: input.agents,
        ...(offered.has(AGENTS_SKILL_ID) ? { runAgent: runAgentFor(spec.agentId) } : {}),
      }
      /** 已经并进 pi 的技能 */
      const loaded = new Set<string>()
      /** 网关说加载成功了、还没并进 pi 的技能（这一批执行完、下一次请求之前在 prepareNextTurnWithContext 里并） */
      const pending: string[] = []
      const onLoaded = (id: string) => {
        if (offered.has(id) && !loaded.has(id) && !pending.includes(id)) pending.push(id)
      }
      const tools: AgentTool[] = [
        remoteTool(createLoadSkillTool(), client, uplink, spec.agentId, 'sequential', onLoaded),
        ...spec.extraTools.map((tool) => ({ ...tool, executionMode: 'sequential' as const })),
      ]
      for (const id of spec.agent.skills.loaded) {
        if (loaded.has(id) || !offered.has(id)) continue
        loaded.add(id)
        tools.push(...toolsOf(id, spec, skillContext))
      }

      /*
       * 模型请求 = pi 的 streamProxy → 网关的 `/model/<agentId>/api/stream`（agent 写在路径里：streamProxy 不让加请求头）。
       * **上下文送空的**（docs/22 §4.3 第 4 步）：服务端只用自己的 transcript。只给中止信号和令牌（快过期时先续期）：
       * 模型、参数、请求头、身份都由服务端定，送了也不用。用全局 fetch（streamProxy 写死的）；工具调用 id 的补齐也在服务端（随 toolcall_end 下发）。
       * 请求之前先冲事件：服务端在这次请求时补齐上一批的结果，runner 执行的工具的结果取上报的，得先到
       */
      const proxyUrl = client.modelProxyUrl(spec.agentId)
      const streamFn: StreamFn = async (model, _context, streamOptions) => {
        await uplink.flush()
        return streamProxy(model, normalizeContext({ messages: [] }), {
          authToken: await client.token(),
          proxyUrl,
          ...(streamOptions?.signal ? { signal: streamOptions.signal } : {}),
        })
      }
      const maxTurns = spec.maxTurns
      let turns = 0
      const agent: Agent = new Agent({
        initialState: {
          systemPrompt: '',
          // baseUrl 只是元数据（streamProxy 不看它），填成这个 agent 的模型请求地址
          model: { ...spec.agent.model, baseUrl: proxyUrl },
          thinkingLevel: 'off',
          tools,
          messages: [],
        },
        // pi 1.x 起必填；网关每次请求都判 llm:invoke、按 agent 数步数（docs/22 §4.3）
        streamFn,
        // 并行只给 run_agent：别的工具都标了 sequential，一批里只要有一个就整批顺序执行（pi 的规则，1.4 仍然如此）
        toolExecution: 'parallel',
        beforeToolCall: async ({ toolCall, assistantMessage }) => {
          // request_confirmation：同批还有别的调用就拦下（pi 只在一批结果**全部** terminate 时提前结束）。它在这里执行、到不了网关，
          // 只能在这里拦；规则只看这条回复，服务端按同一条算它在 transcript 里的结果（transcript.ts 的 recordReply）。它不计入工具调用次数
          if (toolCall.name === REQUEST_CONFIRMATION_TOOL_NAME) {
            const mixed = assistantMessage.content.some((part) => part.type === 'toolCall' && part.name !== toolCall.name)
            return mixed ? { block: true, reason: REQUEST_CONFIRMATION_ALONE_REASON } : undefined
          }
          toolCalls += 1
          // 超过上限：网关执行的照常发过去（网关按它的计数拒，回给模型的是同一句话）；runner 执行的命令到不了网关，在这里拦
          if (localCommands.has(toolCall.name) && toolCalls > input.limits.maxToolCalls) {
            return { block: true, reason: toolCallLimitReason(input.limits.maxToolCalls) }
          }
          return undefined
        },
        /*
         * 被调用的 agent 的步数上限：pi 在一步的结果都进了上下文、发 turn_end 之前调它。到了上限、这一步还调了工具（还要再请求模型）
         * → `end`：pi 不再请求模型、照常发 turn_end + agent_end，prompt() 正常返回（不多一次被服务端拒掉的请求）。
         * 出错 / 被中止的那一步 pi 也调它（返回值不看），照样计一步。入口 agent 不设（它的上限只在服务端）。
         */
        ...(maxTurns !== undefined
          ? {
              finishTurn: ({ toolResults }): AgentTurnDecision | undefined => {
                turns += 1
                if (turns < maxTurns || toolResults.length === 0) return undefined
                return { action: 'end' }
              },
            }
          : {}),
        /*
         * 循环要接着请求模型之前（一批工具执行完、turn_end 之后；最终回复之后不调）：并进这一批里新加载的技能的工具
         * （返回的 `context.tools` 是 pi 执行下一批调用用的；`agent.state.tools` 同步写回）。
         */
        prepareNextTurnWithContext: async ({ context }): Promise<AgentLoopTurnUpdate | undefined> => {
          const added: AgentTool[] = []
          for (const id of pending.splice(0)) {
            if (loaded.has(id)) continue
            loaded.add(id)
            added.push(...toolsOf(id, spec, skillContext))
          }
          if (added.length === 0) return undefined
          const merged = [...(context.tools ?? []), ...added]
          agent.state.tools = merged
          // 同一个 messages 数组（pi 接着往里追加），只换工具表
          return { context: { ...context, tools: merged } }
        },
      })
      const stop = () => agent.abort()
      spec.signal?.addEventListener('abort', stop, { once: true })

      // 只报工具的开始 / 结束（runnerEventOf 丢掉别的）；被调用的 agent 的带上它的 id：服务端据此归到它
      agent.subscribe((event) => {
        const slim = runnerEventOf(event)
        if (slim) uplink.push(spec.entry ? slim : { ...slim, agentId: spec.agentId })
      })

      try {
        // 提示词不用给：模型看到的这一轮用户消息在服务端的 transcript 里
        if (!spec.signal?.aborted) await agent.prompt('')
      } finally {
        spec.signal?.removeEventListener('abort', stop)
      }
      return agent
    }

    /**
     * 调用方 `callerId` 的 `run_agent`（docs/20 §3.10.11）：网关登记 → 同一进程里跑被调用的 agent → 交回结果。
     * 阻塞到被调用的 agent 做完；同一批的几个在 pi 的并行工具执行里同时跑。调用方被停（它的 signal）或整轮被杀时被调用的 agent 一起停。
     * 被调用的 agent 能不能再调用别的 agent、用哪个模型、有哪些工具，全看服务端回的它那一份（{@link RunnerAgentSpec}）
     */
    function runAgentFor(callerId: string): NonNullable<SkillContext['runAgent']> {
      return async (toolCallId, args, signal) => {
        // 之前攒着的事件先冲完（顺序：它们发生在这次发起之前）
        await uplink.flush()
        const reply = await client.taskStart({
          agentId: callerId,
          toolCallId,
          agent: args.agent,
          task: args.task,
          nodeIds: args.nodeIds ?? [],
        })
        if (!reply.ok) throw new Error(reply.message)
        const sub = reply.agent
        const controller = new AbortController()
        const abort = () => controller.abort()
        for (const source of [signal, options.signal]) {
          if (source?.aborted) controller.abort()
          source?.addEventListener('abort', abort, { once: true })
        }
        // 「需要确认」在这里执行（结束这个被调用的 agent 的循环）；问的是什么、它怎么结束的，服务端按它的 transcript 判
        const confirm = createRequestConfirmationTool(() => {}) as unknown as AgentTool
        try {
          await runLoop({
            agentId: sub.agentId,
            agent: sub,
            entry: false,
            extraTools: [confirm],
            maxTurns: sub.limits.maxTurns,
            signal: controller.signal,
          })
        } catch (err) {
          // 被调用的 agent 的循环抛了（pi 兜不住的那种）：照样交回 —— 怎么结束的由服务端判，原因只写 runner 自己的日志
          console.warn(`[agent-runner] 被调用的 agent ${sub.agentId}（${sub.name}）的循环异常结束：${err instanceof Error ? err.message : String(err)}`)
        } finally {
          for (const source of [signal, options.signal]) source?.removeEventListener('abort', abort)
        }
        // 它的事件先冲完（服务端按它们补显示、记 runner 执行的工具的结果），再交回
        await uplink.flush()
        const done = await client.taskFinish({ agentId: sub.agentId })
        if (done.isError) throw new Error(done.text)
        return { content: [{ type: 'text', text: done.text }], details: { summary: done.summary, elementIds: done.changedNodeIds } }
      }
    }

    const entry = await runLoop({
      agentId: ENTRY_AGENT_ID,
      agent: input.entry,
      entry: true,
      extraTools: [],
      ...(options.signal ? { signal: options.signal } : {}),
    })
    /*
     * 入口 agent 的循环以出错结束（模型报错，或 pi 兜住的循环失败 `handleRunFailure`：监听器 / 钩子抛错）：原因只写 runner 自己的日志
     * （驱动把 runner 的输出收进服务端日志）。服务端不收它（第 7 版起不上报 message_end），结局由服务端按自己的 transcript 判
     */
    const last = entry.state.messages.at(-1)
    if (last?.role === 'assistant' && last.stopReason === 'error') {
      console.warn(`[agent-runner] 入口 agent 的循环以出错结束：${last.errorMessage ?? '（没有原因）'}`)
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
