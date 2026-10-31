import { normalizeContext, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai'
import { AGENT_TITLE_MAX_LENGTH } from '@shadecn/shared/agent'
import { AGENT_CLIENT_IDENTITY, streamUpstream } from './model-stream.ts'

/**
 * 会话标题生成（docs/20 §3.9「会话标题」）：新会话的第一轮开始后，服务端拿首条用户消息单独问一次模型，
 * 要一个简短的标题，替换掉建会话时先用的「首条消息开头」。
 *
 * **只在服务端**（同 `model-stream.ts`）：真实 key 与上游地址不进沙箱；它不是 runner 的模型请求，
 * 不进任何 agent 的 transcript、不算步数。失败（上游出错、超时、模型答了个空）一律返回 null，调用方保留原标题。
 */

/** 给模型看的用户消息最多取多少字：标题只看开头就够，长消息不值得整段发 */
export const TITLE_SOURCE_MAX_CHARS = 2000

/** 生成标题这次请求的输出上限（token）：标题本身很短；留一点余量给不请求也会先吐几句思考的端点 */
export const TITLE_MAX_OUTPUT_TOKENS = 256

/** 一次生成最多等多久：超时就算失败（原标题留着） */
export const TITLE_TIMEOUT_MS = 20_000

/** 请求模型时希望的标题长度（字）；落库前仍按 `AGENT_TITLE_MAX_LENGTH` 截 */
const TITLE_TARGET_CHARS = 20

export const TITLE_SYSTEM_PROMPT = [
  '你为一段对话起标题。用户会给你这段对话里的第一条消息，你只回复标题本身。',
  `要求：用消息的语言；不超过 ${TITLE_TARGET_CHARS} 个字（英文不超过 8 个词）；概括用户想做的事；`,
  '不要引号、书名号、句末标点、表情、前缀（如「标题：」），不要解释，不要换行。',
].join('\n')

export interface GenerateTitleInput {
  model: Model<Api>
  apiKey: string
  /** 首条用户消息（提及已换成节点名、附件已换成文件名的纯文本） */
  text: string
  signal?: AbortSignal
  /** 服务端调上游用的 fetch（测试注入脚本化上游；同网关的 `upstreamFetch`） */
  fetch?: typeof fetch
}

export interface GeneratedTitle {
  title: string
  /** 这次请求的用量（计入这一轮的用量） */
  usage: AssistantMessage['usage']
}

/** 问一次模型要标题；拿不到可用的标题返回 null（不抛） */
export async function generateConversationTitle(input: GenerateTitleInput): Promise<GeneratedTitle | null> {
  const source = Array.from(input.text.trim()).slice(0, TITLE_SOURCE_MAX_CHARS).join('')
  if (!source) return null
  const timeout = AbortSignal.timeout(TITLE_TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  try {
    const stream = streamUpstream(
      input.model,
      normalizeContext({
        systemPrompt: TITLE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: source }], timestamp: Date.now() }],
      }),
      {
        apiKey: input.apiKey,
        signal,
        maxTokens: Math.min(TITLE_MAX_OUTPUT_TOKENS, input.model.maxTokens > 0 ? input.model.maxTokens : TITLE_MAX_OUTPUT_TOKENS),
        identity: AGENT_CLIENT_IDENTITY,
        maxRetries: 1,
        ...(input.fetch ? { fetch: input.fetch } : {}),
      },
    )
    const message = await stream.result()
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      console.warn(`[agent] 会话标题没能生成：${message.errorMessage ?? message.stopReason}`)
      return null
    }
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    const title = normalizeGeneratedTitle(text)
    return title ? { title, usage: message.usage } : null
  } catch (err) {
    console.warn('[agent] 会话标题没能生成', err)
    return null
  }
}

/**
 * 模型回的标题 → 能落库的标题：去掉思考标签、「标题：」前缀、首尾引号 / 书名号 / 句末标点，取第一行，折空白，
 * 按 `AGENT_TITLE_MAX_LENGTH` 截（截断处加「…」）。什么都不剩返回空串
 */
export function normalizeGeneratedTitle(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const line = text.split(/\r?\n/).map((item) => item.trim()).find((item) => item.length > 0) ?? ''
  text = line
    .replace(/^(?:#+\s*)?(?:标题|title)\s*[:：]\s*/i, '')
    // 首尾的引号 / 书名号 / markdown 记号，以及句末标点（两者可能交替出现：「标题」。）
    .replace(/^[\s"'“”‘’「」『』《》*_`]+|[\s"'“”‘’「」『』《》*_`。．.!！?？,，;；:：、]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(text)
  if (chars.length <= AGENT_TITLE_MAX_LENGTH) return text
  return `${chars.slice(0, AGENT_TITLE_MAX_LENGTH - 1).join('').trimEnd()}…`
}
