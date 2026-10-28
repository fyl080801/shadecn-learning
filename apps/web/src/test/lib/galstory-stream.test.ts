import { afterEach, describe, expect, it, vi } from "vitest"

import { followRun } from "@/lib/galstory"
import type { RunEvent } from "@/types/galstory"

/**
 * 事件流那一层的判据。
 *
 * 这里守的都是「坏了也不报错、只是界面看着不对」的那类：帧被切在半路、序号没跟上、
 * 同一段叙事被渲染两遍。它们全都不会抛异常。
 */

afterEach(() => vi.restoreAllMocks())

/** 把若干块字节拼成一条流。**块的边界故意切在帧中间** —— 真实网络就是这样 */
function streamOf(chunks: string[]) {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[i++]!))
      else controller.close()
    }
  })
}

function mockSSE(chunks: string[]) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(streamOf(chunks), {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    })
  )
}

async function collect(chunks: string[]) {
  mockSSE(chunks)
  const seen: Array<{ event: RunEvent; seq: number }> = []
  await followRun("save1", (event, seq) => seen.push({ event, seq }))
  return seen
}

describe("SSE 分帧", () => {
  it("一帧被切成好几块也要拼回来 —— 网络本来就不按帧给", async () => {
    const seen = await collect([
      'id: 1\ndata: {"type":"RUN',
      '_STARTED"}\n\nid: 2\ndata: {"ty',
      'pe":"RUN_FINISHED"}\n\n'
    ])

    expect(seen.map((s) => s.event.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"])
  })

  it("序号跟着 id 走 —— 断线重连要拿它当 after，跟丢了就会重复收一段", async () => {
    const seen = await collect(['id: 7\ndata: {"type":"A"}\n\nid: 8\ndata: {"type":"B"}\n\n'])

    expect(seen.map((s) => s.seq)).toEqual([7, 8])
  })

  it("认 \\r\\n 的行尾 —— 链路上任何一层反代都可能改它", async () => {
    const seen = await collect(['id: 1\r\ndata: {"type":"A"}\r\n\r\n'])

    expect(seen).toHaveLength(1)
  })

  it("解不出来的那一帧丢掉就好，绝不把整条流带崩", async () => {
    // 引擎以后加的事件、或者中途截断的一帧，都不该让后面的事件收不到
    const seen = await collect([
      'data: {坏掉的 json\n\ndata: {"type":"RUN_FINISHED"}\n\n'
    ])

    expect(seen.map((s) => s.event.type)).toEqual(["RUN_FINISHED"])
  })

  it("多行 data 按规范拼起来", async () => {
    const seen = await collect(['data: {"type":\ndata: "A"}\n\n'])

    expect(seen[0]?.event.type).toBe("A")
  })

  it("带 after 时把它拼进查询串 —— 这就是断点续传", async () => {
    mockSSE([])
    await followRun("save 1", () => {}, { after: 12 })

    expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]).toBe(
      "/api/galstory/saves/save%201/events?after=12"
    )
  })

  it("打不开时抛出引擎那句话（它写着接下来该做什么）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "上没有可跟的 run。先 POST …" }), {
        status: 404,
        headers: { "content-type": "application/json" }
      })
    )

    await expect(followRun("s", () => {})).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("先 POST")
    })
  })
})

describe("续传的序号只在同一条 run 内有意义", () => {
  it("换一条 run 就要从 0 收 —— seq 是每条 run 各自从 1 起的，不是全局单调", async () => {
    /**
     * 这条守的是一个**吃掉整整一轮**的 bug：第一轮结束时 seq 到了 30，第二轮是**新的一条
     * run**、seq 又从 1 起；拿 30 去 `?after=` 的话，引擎会把序号不大于 30 的全部跳过 ——
     * 症状是「第二轮明明跑完了，界面上一条消息、一步流水线都没有」。
     *
     * 判据落在 `followRun` 的查询串上：`after` 是 0/undefined 时**不许**带这个参数。
     */
    mockSSE([])
    await followRun("s", () => {}, { after: 0 })

    expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]).toBe("/api/galstory/saves/s/events")
  })

  it("同一条 run 内断线重连才带 after", async () => {
    mockSSE([])
    await followRun("s", () => {}, { after: 30 })

    expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]).toBe(
      "/api/galstory/saves/s/events?after=30"
    )
  })
})
