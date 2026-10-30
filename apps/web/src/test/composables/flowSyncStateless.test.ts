import { describe, expect, it } from "vitest"
import { statelessTypeOf } from "@/composables/flow/sync/stateless"

describe("statelessTypeOf()", () => {
  it("只认 JSON 对象上非空的字符串 type，其余一律 null、不抛", () => {
    expect(statelessTypeOf(JSON.stringify({ type: "agent:runs", runs: [] }))).toBe("agent:runs")
    expect(statelessTypeOf(JSON.stringify({ type: "" }))).toBeNull()
    expect(statelessTypeOf(JSON.stringify({ type: 1 }))).toBeNull()
    expect(statelessTypeOf(JSON.stringify(["agent:runs"]))).toBeNull()
    expect(statelessTypeOf("null")).toBeNull()
    expect(statelessTypeOf("不是 JSON")).toBeNull()
  })
})
