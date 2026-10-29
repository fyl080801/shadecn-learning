import { describe, expect, it } from "vitest"
import { fitMediaSize, MEDIA_FIXED_SIDE, MEDIA_MAX_RATIO } from "@/lib/flow-media-size"

describe("fitMediaSize", () => {
  it("竖图：宽固定，高按比例", () => {
    expect(fitMediaSize(1080, 1920)).toEqual({ width: MEDIA_FIXED_SIDE, height: 427 })
  })

  it("横图：高固定，宽按比例", () => {
    expect(fitMediaSize(1920, 1080)).toEqual({ width: 427, height: MEDIA_FIXED_SIDE })
  })

  it("方图：两边都是固定边长", () => {
    expect(fitMediaSize(500, 500)).toEqual({ width: MEDIA_FIXED_SIDE, height: MEDIA_FIXED_SIDE })
  })

  it("超长图：比例夹在上限以内", () => {
    expect(fitMediaSize(10000, 100)).toEqual({ width: MEDIA_FIXED_SIDE * MEDIA_MAX_RATIO, height: MEDIA_FIXED_SIDE })
    expect(fitMediaSize(100, 10000)).toEqual({ width: MEDIA_FIXED_SIDE, height: MEDIA_FIXED_SIDE * MEDIA_MAX_RATIO })
  })

  it("量不出尺寸（解码失败为 0、NaN）→ null", () => {
    expect(fitMediaSize(0, 100)).toBeNull()
    expect(fitMediaSize(100, Number.NaN)).toBeNull()
  })
})
