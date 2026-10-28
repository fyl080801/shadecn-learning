import { afterEach, describe, expect, it, vi } from "vitest"

import { createId } from "@/lib/id"

afterEach(() => {
  vi.useRealTimers()
})

describe("createId()", () => {
  it("形如 <前缀>_<时间戳 base36>_<随机段>", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"))

    const id = createId("n")
    const [prefix, ts, random] = id.split("_")

    expect(prefix).toBe("n")
    expect(Number.parseInt(ts!, 36)).toBe(Date.parse("2026-01-02T03:04:05.000Z"))
    expect(random).toMatch(/^[0-9a-z]{8}$/)
  })

  it("同一毫秒内连续生成也不重复 —— 协同时靠这个不撞 id", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"))

    const ids = new Set(Array.from({ length: 1000 }, () => createId("n")))
    expect(ids.size).toBe(1000)
  })

  it("时间戳打头，先生成的排在前面", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"))
    const older = createId("tx")

    vi.setSystemTime(new Date("2026-01-02T03:04:06.000Z"))
    const newer = createId("tx")

    expect(older < newer).toBe(true)
  })
})
