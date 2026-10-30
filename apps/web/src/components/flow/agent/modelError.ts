/**
 * 一轮失败的原因（`RUN_ERROR.message`、任务的 `error`）在对话里怎么显示 —— 只是展示层的解析，数据原样不动。
 *
 * 模型报错是 pi（`@earendil-works/pi-ai`）拼的，服务端原样转发。pi 1.x 的 `formatProviderError` 把上游的错误体接在状态码后面：
 * - `400: {"message":"额度用完","type":"invalid_request_error"}`（OpenAI SDK 等：状态码 + 原始 JSON 体，体超过 4000 字截断）；
 * - `OpenAI (429): {…}`（带提供方前缀的写法）；
 * - `400 {"type":"error","error":{"type":"…","message":"…"}}`（Anthropic SDK 自己就把体拼进了 message）；
 * - 老数据（pi 0.73）是 `400 额度用完`。
 *
 * pi 自己的 TUI 不解析：`Error: <errorMessage>` 一整行原样换行显示（`coding-agent` 的 `assistant-message.ts`）。
 * 我们沿用它「原文一个字不丢」的原则，只多做一步：认得出「状态码 + JSON 体」就把体里的 `message` 当正文，
 * 状态码 / 错误类型 / 错误码单独标出来，原文收进可展开的一栏；认不出的（截断了、不是 JSON、我们自己的中文原因）照旧整句显示。
 */

export interface ModelErrorView {
  /** 正文：认出来的上游 `message`，否则就是原文（或去掉状态码之后的那段） */
  message: string
  /** HTTP 状态码（只认 4xx / 5xx） */
  status: number | null
  /** 带前缀写法里的提供方名（`OpenAI (429): …` 的 `OpenAI`） */
  source: string | null
  /** 上游错误体里的 `type`（Anthropic 外层的 `"type":"error"` 不算） */
  type: string | null
  /** 上游错误体里的 `code` */
  code: string | null
  /** 正文是从 JSON 里取出来的时候保留原文（展开看）；正文就是原文时为 null */
  raw: string | null
}

/** `OpenAI (429): <体>` */
const PREFIXED = /^(?<source>[^\n():]{1,60}) \((?<status>[45]\d\d)\): (?<body>[\s\S]+)$/
/** `400: <体>`、`400 <体>` */
const PLAIN = /^(?<status>[45]\d\d):? (?<body>[\s\S]+)$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null

/** 从上游的 JSON 错误体里取 message / type / code：OpenAI 是平铺或包在 `error` 里，Anthropic 包在 `error` 里且外层 `type` 恒为 `error` */
function readBody(body: string): { message: string | null; type: string | null; code: string | null } | null {
  if (!body.startsWith("{")) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const inner = isRecord(parsed.error) ? parsed.error : null
  const outerType = text(parsed.type)
  return {
    message: text(inner?.message) ?? text(parsed.message) ?? text(parsed.error) ?? text(parsed.detail),
    type: text(inner?.type) ?? (outerType === "error" ? null : outerType),
    code: text(inner?.code) ?? text(parsed.code)
  }
}

export function parseModelError(input: string): ModelErrorView {
  const original = input.trim()
  const plain: ModelErrorView = { message: input, status: null, source: null, type: null, code: null, raw: null }
  const match = PREFIXED.exec(original) ?? PLAIN.exec(original)
  if (!match?.groups) return plain
  const status = Number(match.groups.status)
  const source = match.groups.source?.trim() || null
  const body = (match.groups.body ?? "").trim()
  const fields = readBody(body)
  if (fields?.message) {
    return { message: fields.message, status, source, type: fields.type, code: fields.code, raw: original }
  }
  // 体不是 JSON（截断了、纯文字）或 JSON 里没有 message：体原样当正文，状态码照样单独标
  return { message: body, status, source, type: fields?.type ?? null, code: fields?.code ?? null, raw: null }
}
