import { afterEach, describe, expect, it, vi } from "vitest"

import {
  GalStoryError,
  cardPreview,
  configApi,
  countLevels,
  storyApi,
  structureLabel
} from "@/lib/galstory"
import type { LintIssue } from "@/types/galstory"

/**
 * 数据层的判据。
 *
 * ⚠️ **这里不再有「三层优先级怎么算」的用例**，那是有意的：那条规则的唯一声明处在引擎
 * （`AgentClients.binding_of`），现在随 `GET /api/config` 的 `bindings[]` 一起下发。
 * 前端要是还留着一份实现与一份测试，两份就会各自演化 —— 而漂了不报错，只是矩阵上显示的
 * 绑定与引擎实际打过去的那条不是同一个。前端这一层现在只负责「发请求 + 把错误说清楚」。
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })
}

afterEach(() => vi.restoreAllMocks())

describe("请求走反代，不直连引擎", () => {
  it("路径挂在 /api/galstory 之下（引擎那一侧的 /api 由反代补）", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]))

    await storyApi.list()

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/galstory/stories")
  })

  it("故事名进路径要转义 —— 目录名不保证是 URL 安全的", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}))

    await storyApi.get("a b/c")

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/galstory/stories/a%20b%2Fc")
  })
})

describe("错误信息用上游那句，不自己编", () => {
  it("引擎的 detail 原样带出来 —— 它写的是「接下来该做什么」", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "这一局还没装配——先 POST /api/saves/x/open" }, 409)
    )

    await expect(configApi.get()).rejects.toMatchObject({
      status: 409,
      message: "这一局还没装配——先 POST /api/saves/x/open"
    })
  })

  it("反代的 error + hint 也带出来（没配后端就是这一档）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "GalStory 后端未配置", hint: "在 .env 里设 GAL_STORY_API_URL" }, 503)
    )

    const err = await configApi.get().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(GalStoryError)
    expect(err).toMatchObject({ status: 503, hint: "在 .env 里设 GAL_STORY_API_URL" })
  })

  it("响应体不是 JSON 时给个带状态码的兜底，而不是把解析异常抛出去", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>502</html>", { status: 502 }))

    await expect(storyApi.list()).rejects.toMatchObject({ status: 502, message: "请求失败（502）" })
  })
})

describe("countLevels", () => {
  it("三级各数各的；一条都没有时三个 0（不是 undefined）", () => {
    const issues: LintIssue[] = [
      { code: "a", level: "warn", where: "x", message: "" },
      { code: "b", level: "warn", where: "y", message: "" },
      { code: "c", level: "info", where: "", message: "" }
    ]

    expect(countLevels(issues)).toEqual({ error: 0, warn: 2, info: 1 })
    expect(countLevels([])).toEqual({ error: 0, warn: 0, info: 0 })
  })
})

describe("structureLabel", () => {
  it("没写 stages 时说「默认单场景」，不说「0 幕」", () => {
    // 那类故事没有转场、也就没有回退点 —— 是玩法上的真实差别，不是一个为 0 的计数
    expect(structureLabel(0, 1)).toBe("默认单场景")
  })

  it("选单那条口不给舞台数，只按场景数说", () => {
    expect(structureLabel(null, 1)).toBe("单场景")
    expect(structureLabel(null, 4)).toBe("4 场")
  })

  it("有舞台就两个数一起给", () => {
    expect(structureLabel(2, 4)).toBe("2 幕 · 4 场")
  })
})

describe("cardPreview", () => {
  it("去掉空行与那条 Name: —— 名字就印在预览上方，重复一遍等于把两行预览浪费掉", () => {
    const card = "Name: 沈青\n\ngender: 女\n\nAppearance:\n-挽起的发髻"

    expect(cardPreview(card)).toBe("gender: 女 · Appearance: · -挽起的发髻")
  })

  it("没有 Name: 行的普通描述原样接起来", () => {
    expect(cardPreview("讲台边收拾教具的老师。\n袖口沾着粉笔灰。")).toBe(
      "讲台边收拾教具的老师。 · 袖口沾着粉笔灰。"
    )
  })
})
