import { describe, expect, it } from "vitest"
import { createSseParser, readSseStream, type SseFrame } from "@/lib/sse"

/**
 * SSE 增量解析。这里守的都是「不报错、只是少了一帧 / 多了半帧」的那一类：
 * 块的边界落在帧中间、落在 `\r\n` 中间，反代把行尾改成 `\r\n`，心跳注释混在中间。
 */

function feed(chunks: string[]): SseFrame[] {
  const parser = createSseParser()
  const out: SseFrame[] = []
  for (const chunk of chunks) out.push(...parser.push(chunk))
  parser.end()
  return out
}

describe("SSE 解析", () => {
  it("空行结束一帧；没有 event 行时 event 为 null（AG-UI 的帧就是这样）", () => {
    expect(feed(['data: {"type":"RUN_STARTED"}\n\n'])).toEqual([
      { event: null, data: '{"type":"RUN_STARTED"}', id: null }
    ])
  })

  it("一帧被切在任意位置，拼回来还是同一帧", () => {
    const whole = 'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"你好"}\n\ndata: {"type":"RUN_FINISHED"}\n\n'
    const expected = feed([whole])
    for (let cut = 1; cut < whole.length; cut++) {
      expect(feed([whole.slice(0, cut), whole.slice(cut)])).toEqual(expected)
    }
    expect(expected).toHaveLength(2)
  })

  it("行尾是 \\r\\n 也认，\\r\\n 被切在两块之间也不会多出一个空行", () => {
    expect(feed(["data: a\r\n\r\ndata: b\r", "\n\r\n"])).toEqual([
      { event: null, data: "a", id: null },
      { event: null, data: "b", id: null }
    ])
  })

  it("单独的 \\r 也算行尾", () => {
    expect(feed(["data: a\r\rdata: b\r\r"]).map((frame) => frame.data)).toEqual(["a", "b"])
  })

  it("多行 data 用 \\n 拼起来", () => {
    expect(feed(["data: {\"a\":\ndata: 1}\n\n"])[0]?.data).toBe('{"a":\n1}')
  })

  it("冒号开头的注释（心跳）整行忽略，不会凑出一帧", () => {
    expect(feed([": ping\n\n", ": keep-alive\ndata: x\n\n"])).toEqual([
      { event: null, data: "x", id: null }
    ])
  })

  it("冒号后只去掉一个空格；event / id 字段照常解析", () => {
    expect(feed(["event: custom\nid: 7\ndata:  two-spaces\n\n"])).toEqual([
      { event: "custom", data: " two-spaces", id: "7" }
    ])
  })

  it("流结束时没有空行收尾的残帧不派发", () => {
    expect(feed(['data: {"type":"RUN_FINISHED"}\n'])).toEqual([])
  })

  it("从字节流读：多字节字符被切在两块之间也能正确解码", async () => {
    const bytes = new TextEncoder().encode("data: 画布\n\n")
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // 「画」是 3 个字节，从中间切开
        controller.enqueue(bytes.slice(0, 7))
        controller.enqueue(bytes.slice(7))
        controller.close()
      }
    })
    const frames: SseFrame[] = []
    await readSseStream(body, (frame) => frames.push(frame))
    expect(frames.map((frame) => frame.data)).toEqual(["画布"])
  })
})
