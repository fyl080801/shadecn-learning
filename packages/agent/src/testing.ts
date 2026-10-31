import { fauxAssistantMessage, fauxToolCall, type Api, type AssistantMessage, type Context, type JsonObject, type Message, type Model, type Tool } from '@earendil-works/pi-ai'
import type { AgentGatewayConfig, AgentRuntimeOptions } from './session.ts'
import type { ResolvedAgentModel } from './model.ts'
import { AGENT_GATEWAY_PATH } from './protocol.ts'
import { createInlineDriver } from './sandbox/drivers/inline.ts'
import { createMemoryLeaseRegistry } from './occupancy.ts'
import { createMemoryRunRegistry } from './run-registry.ts'
import type { SandboxDriver } from './sandbox/driver.ts'
import { createAgentRegistry, DEFAULT_AGENT_MODEL, loadAgentConfigs, type AgentRegistry } from './agents.ts'
import { BUILTIN_SKILLS, type SkillRegistry } from './skills/index.ts'
import { fileURLToPath } from 'node:url'

export { createInlineDriver, type InlineDriverOptions } from './sandbox/drivers/inline.ts'

/**
 * **测试专用**：让一轮 agent 走完整的生产路径（runner 的 `streamProxy` → 网关 → 服务端的 `streamSimple` → 上游），又不碰网络。
 *
 * - {@link registerScriptedModel}：一个脚本化的 OpenAI 兼容上游（`/chat/completions`，流式 SSE），由**服务端**的 pi-ai
 *   `streamSimple` 经 `ProviderRequestOptions.fetch`（`AgentGatewayConfig.upstreamFetch`）去调，所以照样走真实的 SDK 解析路径。
 *   写法照 pi-ai 的 faux provider：每一步给一条 `AssistantMessage`（`fauxAssistantMessage` / `fauxText` /
 *   `fauxToolCall` 照用），或一个 `(context, { signal }, state) => AssistantMessage` 的函数 ——
 *   `context` 是把这次 OpenAI 请求还原成的 pi `Context`（消息、工具），`signal` 在这一轮被叫停时掐断。
 *   它只认服务端那把 key（{@link SCRIPTED_API_KEY}），收到的每个请求记在 `requests` 里 —— 就是服务端真正发出去的请求
 *   （模型、参数、请求头都是服务端定的那份）。
 * - {@link gatewayFetch}：把发往 {@link TEST_GATEWAY_URL} 的请求直接交给 `runtime.gateway.handle`（不开端口）。
 *   runner 里 pi 的 `streamProxy` 用的是全局 fetch，所以测试要 `vi.stubGlobal('fetch', gatewayFetch(...))`。
 * - {@link createInlineDriver}：进程内的驱动（runner 在当前进程里跑，照样只经网关协议说话）。
 * - {@link testAgentRegistry}：仓库里真实的 agent 定义（`packages/agent/agents/`），`runtimeOptions()` 已带上。
 *
 * 生产代码不 import 这个文件。
 */

/** 测试里 runner 看到的网关地址 */
export const TEST_GATEWAY_ORIGIN = 'http://gateway.test'
export const TEST_GATEWAY_URL = `${TEST_GATEWAY_ORIGIN}${AGENT_GATEWAY_PATH}`
export const TEST_TOKEN_SECRET = 'test-agent-token-secret'

/** 脚本化上游的地址与 key（只在服务端；runner 永远看不到它们） */
export const SCRIPTED_UPSTREAM_URL = 'http://llm.upstream.test/v1'
export const SCRIPTED_API_KEY = 'upstream-secret-key'

export type ScriptedStep =
  | AssistantMessage
  | ((context: Context, options: { signal?: AbortSignal }, state: { callCount: number }) => AssistantMessage | Promise<AssistantMessage>)

export interface UpstreamRequest {
  url: string
  headers: Headers
  body: unknown
}

export interface ScriptedModel {
  readonly model: ResolvedAgentModel
  /** 它的上游地址（`baseUrl`）：模型表里有多项时，按地址分辨请求打到了哪一个 */
  readonly upstreamUrl: string
  readonly state: { callCount: number }
  readonly requests: UpstreamRequest[]
  setResponses(steps: ScriptedStep[]): void
  appendResponses(steps: ScriptedStep[]): void
  /** 服务端调上游用的 fetch（`AgentGatewayConfig.upstreamFetch`） */
  readonly fetch: typeof fetch
  /**
   * 一行拿齐 `createAgentRuntime` 要的模型 / 驱动 / 网关 / 占用登记表；登记表每次调用一份新的内存实现，
   * 要让两个 runtime 互相看见占用就自己传同一份
   */
  runtimeOptions(driver?: SandboxDriver): Pick<AgentRuntimeOptions, 'model' | 'driver' | 'gateway' | 'leases' | 'runRegistry' | 'agents'>
}

/** 文字切成几段流出去：接回 / 补发的测试要看到多帧 TEXT_MESSAGE_CONTENT */
const CHUNK = 16

interface OpenAiRequestMessage {
  role: string
  content?: string | null | { type: string; text?: string; image_url?: { url?: string } }[]
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/** OpenAI 请求 → pi 的 Context（够测试看用户消息、工具结果、工具清单） */
function contextOf(body: { messages?: OpenAiRequestMessage[]; tools?: { function: Tool }[] }): Context {
  let systemPrompt: string | undefined
  const messages: Message[] = []
  for (const message of body.messages ?? []) {
    if (message.role === 'system' || message.role === 'developer') {
      systemPrompt = typeof message.content === 'string' ? message.content : undefined
    } else if (message.role === 'user') {
      // 图片（pi 把工具结果里的图片放进紧跟着的一条用户消息，`data:` 地址）还原成 pi 的图片块，测试能看到模型收到了什么
      const content =
        typeof message.content === 'string'
          ? message.content
          : (message.content ?? []).map((part) => {
              const data = part.type === 'image_url' ? /^data:([^;]+);base64,(.*)$/s.exec(part.image_url?.url ?? '') : null
              return data
                ? { type: 'image' as const, mimeType: data[1]!, data: data[2]! }
                : { type: 'text' as const, text: part.text ?? '' }
            })
      messages.push({ role: 'user', content, timestamp: 0 })
    } else if (message.role === 'assistant') {
      const text = typeof message.content === 'string' && message.content ? [{ type: 'text' as const, text: message.content }] : []
      const calls = (message.tool_calls ?? []).map((call) => ({
        type: 'toolCall' as const,
        id: call.id,
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments || '{}') as JsonObject,
      }))
      messages.push({
        role: 'assistant',
        content: [...text, ...calls],
        api: 'openai-completions',
        provider: 'scripted',
        model: 'scripted-model',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: calls.length > 0 ? 'toolUse' : 'stop',
        timestamp: 0,
      })
    } else if (message.role === 'tool') {
      messages.push({
        role: 'toolResult',
        toolCallId: message.tool_call_id ?? '',
        toolName: '',
        content: [{ type: 'text', text: typeof message.content === 'string' ? message.content : '' }],
        isError: false,
        timestamp: 0,
      })
    }
  }
  return {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    messages,
    ...(body.tools ? { tools: body.tools.map((tool) => tool.function) } : {}),
  }
}

/** 一条 AssistantMessage → OpenAI 的流式 chunk */
function chunksOf(message: AssistantMessage, model: string): string[] {
  const base = { id: 'chatcmpl-scripted', object: 'chat.completion.chunk', created: 0, model }
  const chunk = (delta: unknown, finish: string | null = null) =>
    JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })
  const out: string[] = []
  let toolIndex = 0
  for (const part of message.content) {
    if (part.type === 'text') {
      for (let at = 0; at < part.text.length; at += CHUNK) out.push(chunk({ content: part.text.slice(at, at + CHUNK) }))
    } else if (part.type === 'thinking') {
      // 思考块：llama.cpp / DeepSeek 的写法（`reasoning_content`），pi-ai 解析成 thinking
      for (let at = 0; at < part.thinking.length; at += CHUNK) out.push(chunk({ reasoning_content: part.thinking.slice(at, at + CHUNK) }))
    } else if (part.type === 'toolCall') {
      out.push(
        chunk({
          tool_calls: [
            { index: toolIndex, id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.arguments) } },
          ],
        }),
      )
      toolIndex += 1
    }
  }
  // 出错的那一步（流到一半断掉）没有结束块
  if (message.stopReason !== 'error') {
    const finish = message.stopReason === 'toolUse' ? 'tool_calls' : message.stopReason === 'length' ? 'length' : 'stop'
    out.push(chunk({}, finish))
  }
  // 用量块（OpenAI 的 `stream_options.include_usage` 写法：`choices` 为空、带 `usage`，在结束块之后）；脚本没给用量就不发
  const { usage } = message
  if (usage && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0) {
    out.push(
      JSON.stringify({
        ...base,
        choices: [],
        usage: {
          prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
          completion_tokens: usage.output,
          prompt_tokens_details: { cached_tokens: usage.cacheRead, cache_write_tokens: usage.cacheWrite },
        },
      }),
    )
  }
  return out
}

/** 脚本给了用量（token 数不全为 0） */
const hasUsage = (message: AssistantMessage) =>
  Boolean(message.usage) && message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite > 0

function abortError(): Error {
  const err = new Error('This operation was aborted')
  err.name = 'AbortError'
  return err
}

/**
 * `imageInput`：模型声明吃图片（`model.input` 含 `image`），测多模态工具用。
 * `cost`：模型的价格（每百万 token 的美元价，同 pi 的 `Model.cost`）；不给 = 全 0（没有价格信息，同自定义端点）。
 *
 * `id` / `baseUrl` / `apiKey`：模型表里要第二个模型时（docs/26 §3.4）给它另一个模型 id、上游地址和 key，
 * 两个上游用 {@link combineUpstreams} 合成一个 `upstreamFetch`；不给 = `scripted-model` / {@link SCRIPTED_UPSTREAM_URL} / {@link SCRIPTED_API_KEY}。
 *
 * 一步的 `usage` 给了 token 数就随流发一个用量块（pi-ai 据此算 `usage` 与费用）。`stopReason: 'error'` 的一步：
 * 没给用量 = 上游直接回 400；给了用量 = 开流、发完内容和用量块后流断掉（上游中途失败，pi 报出已有的那部分用量）。
 */
export function registerScriptedModel(
  options: { label?: string; imageInput?: boolean; cost?: Model<Api>['cost']; id?: string; baseUrl?: string; apiKey?: string } = {},
): ScriptedModel {
  const upstreamUrl = options.baseUrl ?? SCRIPTED_UPSTREAM_URL
  const apiKey = options.apiKey ?? SCRIPTED_API_KEY
  const queue: ScriptedStep[] = []
  const state = { callCount: 0 }
  const requests: UpstreamRequest[] = []
  const model: Model<Api> = {
    id: options.id ?? 'scripted-model',
    name: options.label ?? 'Faux',
    api: 'openai-completions',
    provider: 'scripted',
    baseUrl: upstreamUrl,
    reasoning: false,
    input: options.imageInput ? ['text', 'image'] : ['text'],
    cost: options.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      supportsUsageInStreaming: false,
      maxTokensField: 'max_tokens',
    },
  } as Model<Api>
  const resolved: ResolvedAgentModel = { model, apiKey, label: options.label ?? 'Faux' }

  const upstream: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    const raw = typeof init?.body === 'string' ? init.body : ''
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      body = null
    }
    requests.push({ url, headers, body })
    const errorReply = (status: number, message: string) =>
      new Response(JSON.stringify({ error: { message, type: 'invalid_request_error' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (url !== `${upstreamUrl}/chat/completions`) return errorReply(404, `脚本化上游没有 ${url}`)
    if (headers.get('authorization') !== `Bearer ${apiKey}`) return errorReply(401, '上游 key 不对')

    const signal = init?.signal ?? undefined
    if (signal?.aborted) throw abortError()
    const step = queue.shift()
    if (!step) return errorReply(400, '脚本化上游没有更多回复了')
    state.callCount += 1
    const produce = Promise.resolve(
      typeof step === 'function' ? step(contextOf(body as never), signal ? { signal } : {}, state) : step,
    )
    const message = await new Promise<AssistantMessage>((resolve, reject) => {
      const onAbort = () => reject(abortError())
      signal?.addEventListener('abort', onAbort, { once: true })
      produce.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort))
    })
    if (message.stopReason === 'error' && !hasUsage(message)) return errorReply(400, message.errorMessage || '模型调用失败')
    const breaks = message.stopReason === 'error'

    const lines = chunksOf(message, model.id).map((data) => `data: ${data}\n\n`)
    if (!breaks) lines.push('data: [DONE]\n\n')
    const encoder = new TextEncoder()
    let index = 0
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(abortError()), { once: true })
      },
      pull(controller) {
        if (signal?.aborted) return
        if (index >= lines.length) {
          if (breaks) controller.error(new Error(message.errorMessage || '上游的流中途断开'))
          else controller.close()
          return
        }
        controller.enqueue(encoder.encode(lines[index]!))
        index += 1
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  const scripted: ScriptedModel = {
    model: resolved,
    upstreamUrl,
    state,
    requests,
    setResponses(steps) {
      queue.splice(0, queue.length, ...steps)
    },
    appendResponses(steps) {
      queue.push(...steps)
    },
    fetch: upstream,
    runtimeOptions(driver) {
      const gateway: AgentGatewayConfig = { url: TEST_GATEWAY_URL, secret: TEST_TOKEN_SECRET, upstreamFetch: upstream }
      return {
        model: resolved,
        driver: driver ?? createInlineDriver(),
        gateway,
        leases: createMemoryLeaseRegistry(),
        runRegistry: createMemoryRunRegistry(),
        agents: testAgentRegistry(),
      }
    },
  }
  return scripted
}

/**
 * 几个脚本化上游合成一个 `upstreamFetch`（服务端的网关只有一个 fetch）：按请求地址交给 `baseUrl` 对得上的那个，
 * 都对不上交给第一个（它回 404）。模型表里有多个模型时用（docs/26 §3.4：每个 agent 的请求打到它自己模型的上游）
 */
export function combineUpstreams(...models: ScriptedModel[]): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const target = models.find((item) => url.startsWith(`${item.upstreamUrl}/`)) ?? models[0]!
    return target.fetch(input, init)
  }
}

/** 仓库里的 agent 定义目录（`packages/agent/agents/`，按本文件的位置找 —— 只在源码里成立，所以只给测试用；生产由宿主传目录） */
export const AGENT_DEFINITIONS_DIR = fileURLToPath(new URL('../agents/', import.meta.url))

/**
 * 测试用的 agent 注册表：读 {@link AGENT_DEFINITIONS_DIR} 里的真实定义（同生产的那一份），按 `skills` 校验白名单、模型表只有 `default`。
 * 想换定义（比如测白名单）就自己 `createAgentRegistry([...])` 传给 `createAgentRuntime({ agents })`
 */
export function testAgentRegistry(skills: SkillRegistry = BUILTIN_SKILLS): AgentRegistry {
  return createAgentRegistry(loadAgentConfigs(AGENT_DEFINITIONS_DIR), { skills, models: [DEFAULT_AGENT_MODEL] })
}

/** 一步只调 `load_skill({ id })` 的模型回复（docs/23 §3.3：它必须单独成批）—— 按需技能的工具要先加载才在 */
export function loadSkillStep(id: string): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall('load_skill', { id })], { stopReason: 'toolUse' })
}

/**
 * 测试用的全局 fetch：发往 {@link TEST_GATEWAY_ORIGIN} 的交给 `handle`（通常是 `runtime.gateway.handle` 或整个 app 的 fetch），
 * 其余交给 `fallback`（不给就拒绝 —— 测试不该有真实网络请求）。
 */
export function gatewayFetch(
  handle: (request: Request) => Promise<Response> | Response,
  fallback?: typeof fetch,
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(`${TEST_GATEWAY_ORIGIN}/`)) return handle(new Request(input, init))
    if (fallback) return fallback(input, init)
    throw new Error(`[test] 意外的网络请求：${url}`)
  }
}
