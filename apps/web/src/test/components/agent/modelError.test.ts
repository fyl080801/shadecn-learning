import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import { parseModelError } from "@/components/flow/agent/modelError"
import FlowAgentError from "@/components/flow/agent/FlowAgentError.vue"

/**
 * 一轮失败的原因怎么显示（docs/20 F21）：数据保持 pi 1.x 的格式（`400: {"message":…}`），只在展示层拆开。
 * 守两件事：认得出的拆成「正文 + 状态码 / 类型 / 错误码 + 原文」，**原文一个字不丢**；认不出的原样整句显示。
 */

describe("parseModelError", () => {
  it("pi 1.x 的「状态码: JSON 体」（OpenAI 平铺）：正文取 message，状态码和类型单独标，原文保留", () => {
    const raw = '400: {"message":"额度用完","type":"invalid_request_error"}'
    expect(parseModelError(raw)).toEqual({
      message: "额度用完",
      status: 400,
      source: null,
      type: "invalid_request_error",
      code: null,
      raw
    })
  })

  it("OpenAI 兼容端点包在 error 里、带 code；带提供方前缀的写法取出前缀", () => {
    const raw = 'OpenAI (429): {"error":{"message":"Rate limit reached","type":"requests","code":"rate_limit_exceeded"}}'
    expect(parseModelError(raw)).toEqual({
      message: "Rate limit reached",
      status: 429,
      source: "OpenAI",
      type: "requests",
      code: "rate_limit_exceeded",
      raw
    })
  })

  it("Anthropic SDK 的「状态码 空格 JSON」：外层 type=error 不算类型，取内层的", () => {
    const raw = '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_1"}'
    expect(parseModelError(raw)).toMatchObject({ message: "Overloaded", status: 529, type: "overloaded_error", raw })
  })

  it("体不是 JSON / 被截断：体原样当正文，状态码照样标，不另给原文", () => {
    expect(parseModelError("502: Bad Gateway")).toEqual({
      message: "Bad Gateway",
      status: 502,
      source: null,
      type: null,
      code: null,
      raw: null
    })
    const truncated = '400: {"message":"很长很长... [truncated 120 chars]'
    expect(parseModelError(truncated)).toMatchObject({ message: '{"message":"很长很长... [truncated 120 chars]', status: 400, raw: null })
    // pi 0.73 存下来的老格式
    expect(parseModelError("400 额度用完")).toMatchObject({ message: "额度用完", status: 400 })
  })

  it("JSON 里没有 message：整段体当正文", () => {
    expect(parseModelError('500: {"type":"server_error"}')).toMatchObject({
      message: '{"type":"server_error"}',
      status: 500,
      type: "server_error",
      raw: null
    })
  })

  it("我们自己的原因、不像状态码的开头：原样不动", () => {
    for (const text of ["超过本轮步数上限 24，已停止", "agent 运行出错：网关 401", "200: ok", "1234: x", "模型调用失败"]) {
      expect(parseModelError(text)).toEqual({ message: text, status: null, source: null, type: null, code: null, raw: null })
    }
  })
})

describe("FlowAgentError", () => {
  it("认出来的：正文 + 灰字一行（HTTP 状态码 · 类型）+ 收起的原始报错", () => {
    const raw = '400: {"message":"额度用完","type":"invalid_request_error"}'
    const wrapper = mount(FlowAgentError, { props: { text: raw } })
    expect(wrapper.find('[data-role="error-message"]').text()).toBe("额度用完")
    expect(wrapper.findAll('[data-role="error-meta"] > span').map((part) => part.text())).toEqual(["HTTP 400", "· invalid_request_error"])
    const details = wrapper.find('[data-role="error-raw"]')
    expect(details.element.tagName).toBe("DETAILS")
    expect((details.element as HTMLDetailsElement).open).toBe(false)
    expect(details.find("pre").text()).toBe(raw)
  })

  it("认不出的：只有原文那一句，没有附加行", () => {
    const wrapper = mount(FlowAgentError, { props: { text: "这一轮运行失败" } })
    expect(wrapper.text()).toBe("这一轮运行失败")
    expect(wrapper.find('[data-role="error-meta"]').exists()).toBe(false)
    expect(wrapper.find('[data-role="error-raw"]').exists()).toBe(false)
  })
})
