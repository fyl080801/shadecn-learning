import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, authApi } from "@/lib/api"

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth", () => ({ apiFetch }))

const failWith = async (status: number, body: unknown) => {
  apiFetch.mockResolvedValue(new Response(JSON.stringify(body), { status }))
  return authApi.confirmLink().catch((err: unknown) => err as ApiError)
}

describe("失败响应给用户看的话", () => {
  beforeEach(() => apiFetch.mockReset())

  it("后端给了中文 message → 显示它，不显示状态名", async () => {
    const err = await failWith(409, { error: "Conflict", message: "这个账号已经关联到另一个用户" })
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toBe("这个账号已经关联到另一个用户")
    expect((err as ApiError).status).toBe(409)
  })

  it("只有 error → 显示 error", async () => {
    expect((await failWith(400, { error: "sv 不是合法的状态向量" }) as ApiError).message).toBe("sv 不是合法的状态向量")
  })

  it("500 的 message 是未捕获异常的原文，不能给用户看", async () => {
    const err = await failWith(500, { error: "Internal Server Error", message: 'relation "flow" does not exist' })
    expect((err as ApiError).message).toBe("Internal Server Error")
  })

  it("503 的 message 是写给人看的，照常显示", async () => {
    expect((await failWith(503, { error: "Service Unavailable", message: "未配置对象存储" }) as ApiError).message).toBe("未配置对象存储")
  })

  it("401 不看响应体", async () => {
    expect((await failWith(401, { error: "Unauthorized", message: "需要登录" }) as ApiError).message).toBe("登录状态已失效，请重新登录")
  })

  it("框架默认错误体的 message 可能是数组 → 退回 error", async () => {
    expect((await failWith(400, { error: "Bad Request", message: ["a", "b"] }) as ApiError).message).toBe("Bad Request")
  })

  it("响应体不是 JSON → 退回状态码", async () => {
    apiFetch.mockResolvedValue(new Response("<html>", { status: 502 }))
    const err = await authApi.confirmLink().catch((e: unknown) => e as ApiError)
    expect((err as ApiError).message).toBe("请求失败（502）")
  })
})
