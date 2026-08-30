import { afterEach, describe, expect, it, vi } from "vitest"

import { configApi, runApi, saveApi } from "@/lib/galstory"
import { diffPatch, linesToList, numberOrKeep, numberOrNull } from "@/lib/galstory-form"

/**
 * 配置表单那一层的判据。
 *
 * 最要紧的是**「省略」与「显式 null」是两件事**：引擎那一侧是 patch（省略 = 不动这一项），
 * 而表单天然产出整个对象。直接回传的后果不是「多写几个字段」这么轻 —— 是**往用户手写的
 * `config.yaml` 里塞进他从没写过的行**（接口给的是引擎缺省值，表单原样显示、原样回传，
 * 那一行就凭空长出来，此后引擎缺省值再改它也跟不上了）。
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })
}

afterEach(() => vi.restoreAllMocks())

describe("只发改动过的键", () => {
  it("没动过的字段不进 patch —— 否则引擎缺省值会被写死进用户的配置文件", () => {
    const original = { timeoutS: 40, maxRetries: 2, model: "m" }

    const patch = diffPatch({ timeoutS: 55, maxRetries: 2, model: "m" }, original)

    expect(patch).toEqual({ timeoutS: 55 })
  })

  it("显式清空是一次改动 —— 「把这一项清掉」必须表达得出来", () => {
    const patch = diffPatch({ topP: null }, { topP: 0.9 })

    expect(patch).toEqual({ topP: null })
    expect("topP" in patch).toBe(true)
  })

  it("null 与 undefined 是同一件事，不该制造出假的改动", () => {
    expect(diffPatch({ contextWindow: null }, { contextWindow: undefined })).toEqual({})
  })

  it("新建时只留填了东西的键 —— 空框不该把缺省值写进文件", () => {
    const patch = diffPatch({ id: "new", model: "m", baseUrl: "" }, null)

    expect(patch).toEqual({ id: "new", model: "m" })
  })

  it("数组按元素比，顺序变了才算改动", () => {
    expect(diffPatch({ skills: ["+a", "+b"] }, { skills: ["+a", "+b"] })).toEqual({})
    expect(diffPatch({ skills: ["+b", "+a"] }, { skills: ["+a", "+b"] })).toEqual({
      skills: ["+b", "+a"]
    })
  })
})

describe("空输入：清空还是没填", () => {
  it("可为空的格子，清空 = 显式 null", () => {
    expect(numberOrNull("")).toBeNull()
    expect(numberOrNull("40")).toBe(40)
  })

  it("不可为空的格子，清空 = 保持原值，绝不发 null 过去", () => {
    // 发 null 引擎会 400 拦住，但那是一句用户看不懂的校验错误，而他只是把框清了
    expect(numberOrKeep("", 40)).toBe(40)
    expect(numberOrKeep("55", 40)).toBe(55)
  })

  it("填了非数字按没填算，不产出 NaN", () => {
    expect(numberOrNull("abc")).toBeNull()
    expect(numberOrKeep("abc", 40)).toBe(40)
  })
})

describe("增量列表的多行文本", () => {
  it("空行丢掉 —— 末尾多敲一个回车不该变成一个空名字的条目", () => {
    expect(linesToList("+a\n\n -b \n")).toEqual(["+a", "-b"])
  })
})

describe("写口发出去的请求", () => {
  it("PATCH /config 带 JSON 请求体", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ path: "", created: false, config: {} }))

    await configApi.update({ verify: true })

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("/api/galstory/config")
    expect(init).toMatchObject({ method: "PATCH", body: JSON.stringify({ verify: true }) })
  })

  it("id 进路径要转义 —— 它是用户填的", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ path: "", created: true, config: {} }))

    await configApi.saveConnection("a b", { model: "m" })

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/galstory/config/connections/a%20b")
  })

  it("删除默认不带 force —— 先让引擎告诉我们谁还指着它", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ path: "", created: false, config: {} }))

    await configApi.deleteConnection("base")

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("/api/galstory/config/connections/base")
    expect(init).toMatchObject({ method: "DELETE" })
  })

  it("确认之后才带 force", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ path: "", created: false, config: {} }))

    await configApi.deleteConnection("base", true)

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/galstory/config/connections/base?force=true")
  })

  it("409「还被指着」的那句话原样带出来 —— 里面有决定要不要强删所需的全部信息", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "这条连接还被这些地方指着：['default_connect']" }, 409)
    )

    await expect(configApi.deleteConnection("base")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("default_connect")
    })
  })
})

describe("配额与在跑的回合", () => {
  it("429 的 detail 是个**对象**，要抠出里面那句人话而不是 [object Object]", async () => {
    // FastAPI 的 HTTPException(429, {...}) 把整个 dict 塞进 detail。直接往外抛，
    // 界面上就是一句 [object Object]，而它本来带着「哪几局在跑、跑了多久」。
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          detail: {
            detail: "你已经有 2 轮在跑（上限 2）",
            code: "too_many_runs",
            running: [{ saveId: "s1", runId: "r1", elapsed: 12.3 }]
          }
        },
        429
      )
    )

    await expect(configApi.get()).rejects.toMatchObject({
      status: 429,
      message: "你已经有 2 轮在跑（上限 2）",
      code: "too_many_runs"
    })
  })

  it("载荷也带出来 —— 「哪几局在跑」正是界面要显示的", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        { detail: { detail: "满了", code: "too_many_runs", running: [{ saveId: "s1" }] } },
        429
      )
    )

    await expect(configApi.get()).rejects.toMatchObject({
      payload: { running: [{ saveId: "s1" }] }
    })
  })

  it("detail 是普通字符串时行为不变（别为了新分支把老路弄坏）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "未找到存档「x」" }, 404)
    )

    await expect(configApi.get()).rejects.toMatchObject({
      status: 404,
      message: "未找到存档「x」",
      code: ""
    })
  })

  it("在跑的回合走 GET /runs", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ limit: 2, running: [] }))

    await runApi.list()

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/galstory/runs")
  })
})

describe("对局的装配", () => {
  it("没装配过时 GET /state 是 409 —— 那是要分流的状态，不是加载失败", async () => {
    // 引擎拒绝替调用方决定花建档那笔钱，故 409 并指路。对局界面据此把装配交给第一轮，
    // 那一轮的 worker 自己装配，建档进度从事件流上走出来。
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "这一局还没装配——先 POST /api/saves/x/open" }, 409)
    )

    await expect(saveApi.state("x")).rejects.toMatchObject({ status: 409 })
  })

  it("演一轮走 POST turns，立刻回 202 的那条", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ saveId: "x", runId: "r", accepted: true }))

    await saveApi.playTurn("x", "推门进去")

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("/api/galstory/saves/x/turns")
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ text: "推门进去" }) })
  })
})
