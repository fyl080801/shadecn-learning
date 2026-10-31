import { describe, expect, it } from "vitest"
import type { FlowNodeInput } from "@shadecn/shared/flow-graph"

import {
  acceptedInputMedia,
  inputMediaAccept,
  inputMediaKindOf,
  moveItem,
  orderedUpstreams,
  readInputOrder
} from "@/components/flow/composer/composer-inputs"

function input(source: string, port = "image", index = 1): FlowNodeInput {
  return { port, index, edgeId: `e-${source}-${port}`, source, sourcePort: port }
}

const all = () => true

describe("orderedUpstreams", () => {
  it("没有记顺序 → 按派生 inputs 的顺序，同一个上游只出现一次", () => {
    const inputs = [input("a"), input("b"), input("a", "video")]
    expect(orderedUpstreams(inputs, [], all)).toEqual(["a", "b"])
  })

  it("记着的按 inputOrder 排在前面，没记着的接在后面，不再连着的跳过", () => {
    const inputs = [input("a"), input("b"), input("c")]
    expect(orderedUpstreams(inputs, ["c", "gone", "a"], all)).toEqual(["c", "a", "b"])
  })

  it("悬空边（上游已经不在）不列", () => {
    expect(orderedUpstreams([input("a"), input("b")], [], (id) => id !== "a")).toEqual(["b"])
  })
})

describe("readInputOrder", () => {
  it("坏数据当没有，不抛", () => {
    expect(readInputOrder(undefined)).toEqual([])
    expect(readInputOrder("a")).toEqual([])
    expect(readInputOrder(["a", 1, "", "b"])).toEqual(["a", "b"])
  })
})

describe("moveItem", () => {
  it("挪到目标位置，别的相对顺序不变", () => {
    expect(moveItem(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"])
    expect(moveItem(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"])
    expect(moveItem(["a", "b"], "x", 0)).toEqual(["a", "b"])
  })
})

describe("加号能选的媒体", () => {
  it("图片 / 视频收图和视频，导演台只收图，文本一种都没有", () => {
    expect(acceptedInputMedia("image")).toEqual(["image", "video"])
    expect(acceptedInputMedia("video")).toEqual(["image", "video"])
    expect(acceptedInputMedia("director")).toEqual(["image"])
    expect(acceptedInputMedia("text")).toEqual([])
    expect(inputMediaAccept(["image"])).toBe("image/*")
  })

  it("不是能接的媒体 → null（accept 只是提示）", () => {
    expect(inputMediaKindOf({ type: "image/png" }, ["image"])).toBe("image")
    expect(inputMediaKindOf({ type: "video/mp4" }, ["image"])).toBeNull()
    expect(inputMediaKindOf({ type: "text/plain" }, ["image", "video"])).toBeNull()
  })
})
