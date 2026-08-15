import { describe, expect, it } from "vitest"
import { cn } from "@/lib/utils"

describe("cn()", () => {
  it("拼接多个 class", () => {
    expect(cn("a", "b")).toBe("a b")
  })

  it("丢掉 falsy 值（clsx 语义）", () => {
    const enabled = false
    expect(cn("a", enabled && "b", undefined, null, "", "c")).toBe("a c")
  })

  it("支持对象/数组写法", () => {
    expect(cn(["a", { b: true, c: false }])).toBe("a b")
  })

  it("后面的 tailwind class 覆盖前面冲突的那个（tailwind-merge 语义）", () => {
    expect(cn("px-2", "px-4")).toBe("px-4")
    expect(cn("text-sm text-muted-foreground", "text-lg")).toBe(
      "text-muted-foreground text-lg"
    )
  })

  it("不冲突的 class 都保留", () => {
    expect(cn("px-2", "py-4")).toBe("px-2 py-4")
  })
})
