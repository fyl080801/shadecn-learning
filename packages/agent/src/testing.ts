import { fauxAssistantMessage, fauxToolCall, type Api, type AssistantMessage, type Context, type JsonObject, type Message, type Model, type Tool } from '@earendil-works/pi-ai'
import type { AgentGatewayConfig, AgentRuntimeOptions } from './session.ts'
import type { ResolvedAgentModel } from './model.ts'
import { AGENT_GATEWAY_PATH } from './protocol.ts'
import { createInlineDriver } from './sandbox/drivers/inline.ts'
import { createMemoryLeaseRegistry } from './occupancy.ts'
import { createMemoryRunRegistry } from './run-registry.ts'
import type { SandboxDriver } from './sandbox/driver.ts'

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
  runtimeOptions(driver?: SandboxDriver): Pick<AgentRuntimeOptions, 'model' | 'driver' | 'gateway' | 'leases' | 'runRegistry'>
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
  const finish = message.stopReason === 'toolUse' ? 'tool_calls' : message.stopReason === 'length' ? 'length' : 'stop'
  out.push(chunk({}, finish))
  return out
}

function abortError(): Error {
  const err = new Error('This operation was aborted')
  err.name = 'AbortError'
  return err
}

/** `imageInput`：模型声明吃图片（`model.input` 含 `image`），测多模态工具用 */
export function registerScriptedModel(options: { label?: string; imageInput?: boolean } = {}): ScriptedModel {
  const queue: ScriptedStep[] = []
  const state = { callCount: 0 }
  const requests: UpstreamRequest[] = []
  const model: Model<Api> = {
    id: 'scripted-model',
    name: options.label ?? 'Faux',
    api: 'openai-completions',
    provider: 'scripted',
    baseUrl: SCRIPTED_UPSTREAM_URL,
    reasoning: false,
    input: options.imageInput ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
  const resolved: ResolvedAgentModel = { model, apiKey: SCRIPTED_API_KEY, label: options.label ?? 'Faux' }

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
    if (url !== `${SCRIPTED_UPSTREAM_URL}/chat/completions`) return errorReply(404, `脚本化上游没有 ${url}`)
    if (headers.get('authorization') !== `Bearer ${SCRIPTED_API_KEY}`) return errorReply(401, '上游 key 不对')

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
    if (message.stopReason === 'error') return errorReply(400, message.errorMessage || '模型调用失败')

    const lines = chunksOf(message, model.id).map((data) => `data: ${data}\n\n`)
    lines.push('data: [DONE]\n\n')
    const encoder = new TextEncoder()
    let index = 0
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(abortError()), { once: true })
      },
      pull(controller) {
        if (signal?.aborted) return
        if (index >= lines.length) {
          controller.close()
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
      }
    },
  }
  return scripted
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
