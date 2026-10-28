/**
 * `text/event-stream` 的增量解析 —— **纯函数，不碰网络**。
 *
 * 为什么不用 `EventSource`：它只会发 GET，而画布 Agent 的一轮是 `POST` 一条 prompt、
 * 响应体就是事件流（`@shadecn/shared/agent`）。所以走 `fetch` + `body.getReader()`，
 * 字节切块到达，这里负责把块拼回一帧一帧。
 *
 * 照 [HTML 规范的 SSE 解析规则](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)
 * 做了实际会遇到的那部分：
 * - 行尾认 `\r\n` / `\n` / `\r` 三种（中间任何一层反代都可能改行尾），
 *   而且 `\r\n` 可能**正好被切在两块之间** —— 块尾的 `\r` 要留到下一块再判；
 * - 空行结束一帧；多行 `data:` 用 `\n` 拼起来；
 * - `:` 开头是注释（服务端拿它做心跳），整行忽略；
 * - 字段名后的冒号之后**只去掉一个空格**（`data:  x` 的值是 ` x`）；
 * - 没有 `data:` 的帧不派发。
 *
 * `id:` / `retry:` 只解析不使用：那是 `EventSource` 断线重连的协议，这里不做重连。
 */

export interface SseFrame {
  /** `event:` 行的值；没有这一行时为 `null`（AG-UI 的帧就不带它，类型在 JSON 里） */
  event: string | null
  /** 所有 `data:` 行按 `\n` 拼起来的结果 */
  data: string
  /** `id:` 行的值 */
  id: string | null
}

export interface SseParser {
  /** 喂一块文本，返回这块里**凑完整**了的帧（可能 0 个，也可能好几个） */
  push(chunk: string): SseFrame[]
  /**
   * 流结束了。按规范，最后一帧没有空行收尾就**不派发**（可能是半截），
   * 这里照办：只清空缓冲，不返回残帧。
   */
  end(): void
}

export function createSseParser(): SseParser {
  /** 还没凑成整行的尾巴 */
  let buffer = ""
  /** 上一块以 `\r` 结尾：下一块开头的 `\n` 属于同一个行尾，要吞掉 */
  let pendingCR = false

  let event: string | null = null
  let id: string | null = null
  let data: string[] = []
  let hasData = false

  function dispatch(out: SseFrame[]) {
    if (hasData) out.push({ event, data: data.join("\n"), id })
    event = null
    data = []
    hasData = false
  }

  function line(text: string, out: SseFrame[]) {
    if (text === "") {
      dispatch(out)
      return
    }
    if (text.startsWith(":")) return

    const colon = text.indexOf(":")
    const field = colon < 0 ? text : text.slice(0, colon)
    let value = colon < 0 ? "" : text.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)

    switch (field) {
      case "data":
        data.push(value)
        hasData = true
        break
      case "event":
        event = value
        break
      case "id":
        // 规范：含 NUL 的 id 要忽略
        if (!value.includes("\0")) id = value
        break
      default:
        // retry 和未知字段一律忽略
        break
    }
  }

  return {
    push(chunk) {
      const out: SseFrame[] = []
      let text = chunk
      if (pendingCR && text.startsWith("\n")) text = text.slice(1)
      pendingCR = false
      buffer += text

      let start = 0
      for (let i = 0; i < buffer.length; i++) {
        const char = buffer.charAt(i)
        if (char !== "\n" && char !== "\r") continue
        line(buffer.slice(start, i), out)
        if (char === "\r") {
          if (i + 1 < buffer.length) {
            if (buffer.charAt(i + 1) === "\n") i++
          } else {
            // `\r` 落在块尾：可能是 `\r\n` 的前半，下一块再看
            pendingCR = true
          }
        }
        start = i + 1
      }
      buffer = buffer.slice(start)
      return out
    },
    end() {
      buffer = ""
      pendingCR = false
      event = null
      id = null
      data = []
      hasData = false
    }
  }
}

/**
 * 把一条字节流读成一帧一帧，逐帧回调。读完（或被 `signal` 中止）才 resolve。
 *
 * `onFrame` 里**别抛异常**：抛出来会中断读循环。解析失败这类事应该在回调里自己吞掉。
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = createSseParser()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) onFrame(frame)
    }
    const rest = decoder.decode()
    if (rest) for (const frame of parser.push(rest)) onFrame(frame)
    parser.end()
  } finally {
    // 读完时是空动作；中途出错时把连接关掉，别让它挂着
    reader.cancel().catch(() => undefined)
  }
}
