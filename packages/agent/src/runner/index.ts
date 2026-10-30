import { Agent, type AgentMessage, type AgentTool } from '@mariozechner/pi-agent-core'
import { runnerEventOf, slimMessage } from '../protocol.ts'
import { openLocalSandbox } from '../sandbox/local.ts'
import type { Sandbox } from '../sandbox/types.ts'
import {
  BUILTIN_SKILLS,
  createLoadSkillTool,
  definitionContext,
  LOAD_SKILL_ALONE_REASON,
  LOAD_SKILL_TOOL_NAME,
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
 * - 工具按模型给的顺序一个一个执行（`toolExecution: 'sequential'`）；超过 `maxToolCalls` 的被拦下并告诉模型；
 * - **别人的改动只在一批调过工具的 `turn_end` 里 steer**（pi 紧接着就取 steer 队列、再请求模型）：
 *   先把事件冲完，再向网关要合并好的那一条通知；模型写最终回复（这一步没调工具）时不 steer ——
 *   否则 pi 会为它再请求一次模型；那些改动由服务端留给跨轮差异。
 *   steer 进去的那条消息在 pi 的 `message_end` 里认出来（对象身份），上报时带上 `steerId`，
 *   服务端那时才发 `agent.canvas-change`（docs/20 §3.10.2：模型确实看到了才算交付）；
 * - 每个画布工具调用之前先冲事件：旁观者先看到 TOOL_CALL_START，再看到画布上的改动。
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
  onLoaded?: (skillId: string) => void,
): AgentTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    async execute(toolCallId, args) {
      await uplink.flush()
      const reply = await client.tool({ toolCallId, name: tool.name, args })
      // 服务端的报错原样交给 pi：它变成 isError 的工具结果回给模型，和在进程内抛出时一样
      if (reply.isError) throw new Error(reply.message)
      if (reply.details.loadedSkill) onLoaded?.(reply.details.loadedSkill)
      return { content: reply.content, details: reply.details, ...(reply.terminate ? { terminate: true } : {}) }
    },
  }
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
    const offered = new Set(input.skills.offered)
    // 提供的技能里有人要在沙箱里执行命令：开这一轮的工作目录，写进服务端准备的文件
    const needsSandbox = input.skills.offered.some((id) => registry.get(id)?.requires.includes('sandbox:exec'))
    if (needsSandbox) {
      sandbox = await openLocalSandbox(options.workdir, options.pathEnv ? { pathEnv: options.pathEnv } : {})
      for (const [file, content] of Object.entries(input.files)) await sandbox.writeFile(file, content)
    }
    const context = definitionContext('runner', sandbox ?? undefined)

    /** 已经并进 pi 的技能 */
    const loaded = new Set<string>()
    /** 网关说加载成功了、还没并进 pi 的技能（这一批结束、循环返回后再并） */
    const pending: string[] = []
    const onLoaded = (id: string) => {
      if (offered.has(id) && !loaded.has(id) && !pending.includes(id)) pending.push(id)
    }
    const toolsOf = (id: string): AgentTool[] => {
      const skill = registry.get(id)
      if (!skill) return []
      return skill
        .tools(context)
        .map((tool) => (tool.execution === 'runner' ? (tool as AgentTool) : remoteTool(tool, client, uplink)))
    }
    const tools: AgentTool[] = [remoteTool(createLoadSkillTool(), client, uplink, onLoaded)]
    for (const id of input.skills.loaded) {
      if (loaded.has(id)) continue
      loaded.add(id)
      tools.push(...toolsOf(id))
    }

    /** steer 进去、还没被 pi 放进上下文的那条消息 → 通知 id */
    const steered = new Map<AgentMessage, string>()
    let toolCalls = 0
    const agent = new Agent({
      initialState: {
        systemPrompt: input.systemPrompt,
        model: { ...input.model, baseUrl: client.llmBaseUrl },
        thinkingLevel: 'off',
        tools,
        messages: input.llmMessages,
      },
      // 交给 SDK 的「key」是 run 短令牌（快过期时先续期）；网关的模型代理每次请求都判 llm:invoke
      getApiKey: () => client.token(),
      toolExecution: 'sequential',
      steeringMode: 'all',
      beforeToolCall: async ({ toolCall, assistantMessage }) => {
        toolCalls += 1
        if (toolCalls > input.limits.maxToolCalls) {
          return { block: true, reason: `本轮工具调用已达上限 ${input.limits.maxToolCalls} 次，请停止并向用户说明进度` }
        }
        // pi 只在一批结果**全部** terminate 时提前结束：和别的工具同批的 load_skill 拦下（别的照常执行）
        if (
          toolCall.name === LOAD_SKILL_TOOL_NAME &&
          assistantMessage.content.some((part) => part.type === 'toolCall' && part.name !== LOAD_SKILL_TOOL_NAME)
        ) {
          return { block: true, reason: LOAD_SKILL_ALONE_REASON }
        }
        return undefined
      },
    })
    const stop = () => agent.abort()
    options.signal?.addEventListener('abort', stop, { once: true })

    /** 已经上报过的 message_end 条数（pi 自己兜住的失败消息不走 message_end，收尾时补报） */
    let ended = 0
    agent.subscribe(async (event) => {
      if (event.type === 'message_end') ended += 1
      const slim = runnerEventOf(event, (message) => steered.get(message))
      if (slim) uplink.push(slim)
      if (event.type === 'message_end' && event.message.role === 'user') steered.delete(event.message)
      if (event.type !== 'turn_end') return
      // 一批结束：先把事件冲完（服务端在这里数步数，超了当场叫停）
      await uplink.flush()
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
      if (!options.signal?.aborted) await agent.prompt(input.prompt)
      // 这一批以 load_skill 提前结束：并进新技能的工具，接着跑（可能多次）。被中止 / 出错收尾的不再继续
      while (pending.length > 0 && !options.signal?.aborted && agent.state.messages.at(-1)?.role === 'toolResult') {
        for (const id of pending.splice(0)) {
          if (loaded.has(id)) continue
          loaded.add(id)
          agent.state.tools = [...agent.state.tools, ...toolsOf(id)]
        }
        await agent.continue()
      }
    } finally {
      options.signal?.removeEventListener('abort', stop)
    }
    for (const message of agent.state.messages.slice(input.llmMessages.length + ended)) {
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
