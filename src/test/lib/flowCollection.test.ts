import { describe, expect, it } from "vitest"
import {
  collectionIdOf,
  collectionKey,
  collectionKeys,
  isCollectionKey,
  readCollection,
  spreadCollection
} from "@/lib/flow-collection"
import { defaultNodeData } from "@/types/flow"

/**
 * 「平铺分键」的纯函数半边 —— 一批会被各改各的元素怎么摊进 `data`。
 * 另一半（写和删同笔落进 Y.Doc）在 `src/test/stores/flow.test.ts`。
 */

const PREFIX = "dc.obj"

function data(extra: Record<string, unknown>) {
  return { ...defaultNodeData("导演台"), ...extra }
}

describe("flow-collection", () => {
  it("键是 `<前缀>.<id>`，id 里带点或冒号也能原样取回来", () => {
    // 时间轴的轨道 id 就长这样：`<uuid>:<property>`
    const id = "5995d993-0205:fov"
    const key = collectionKey("dc.track", id)

    expect(key).toBe("dc.track.5995d993-0205:fov")
    expect(collectionIdOf("dc.track", key)).toBe(id)
  })

  it("只认自己前缀下的键，前缀本身和别人的键都不算", () => {
    expect(isCollectionKey(PREFIX, "dc.obj.a1")).toBe(true)
    // 前缀本身不是集合元素（没有 id 那一段）
    expect(isCollectionKey(PREFIX, "dc.obj")).toBe(false)
    expect(isCollectionKey(PREFIX, "dc.obj.")).toBe(false)
    expect(isCollectionKey(PREFIX, "dc.track.a1")).toBe(false)
    expect(isCollectionKey(PREFIX, "label")).toBe(false)
    expect(collectionIdOf(PREFIX, "label")).toBeNull()
  })

  it("读集合只捞自己那批键，框架字段和别的集合都不带进来", () => {
    const found = readCollection(
      data({
        "dc.obj.a1": { uuid: "a1", name: "男性素体1" },
        "dc.obj.a2": { uuid: "a2", name: "机位1" },
        "dc.track.a1:fov": { property: "fov" },
        prompt: "一只猫"
      }),
      PREFIX
    )

    expect([...found.keys()].sort()).toEqual(["a1", "a2"])
    expect(found.get("a1")).toEqual({ uuid: "a1", name: "男性素体1" })
  })

  it("整批删除拿得到这批键，且不误伤别的前缀", () => {
    const keys = collectionKeys(
      data({ "dc.obj.a1": {}, "dc.obj.a2": {}, "dc.track.a1:fov": {} }),
      PREFIX
    )

    expect(keys.sort()).toEqual(["dc.obj.a1", "dc.obj.a2"])
  })

  it("摊开一批元素得到可以直接并进 data 的键值对", () => {
    const objects = [
      { uuid: "a1", name: "男性素体1" },
      { uuid: "a2", name: "机位1" }
    ]

    expect(spreadCollection(PREFIX, objects, (o) => o.uuid)).toEqual({
      "dc.obj.a1": objects[0],
      "dc.obj.a2": objects[1]
    })
  })

  it("取不出稳定 id 的元素直接跳过 —— 绝不拿下标顶上", () => {
    // 样例数据里真有 5 个没有 uuid 的对象；用下标当 id 会在别人增删后错位，
    // 写就打到别人身上，那正是这套约定要避免的东西
    const objects = [{ uuid: "a1" }, { uuid: "" }, {} as { uuid?: string }]
    const spread = spreadCollection(PREFIX, objects, (o) => o.uuid ?? "")

    expect(Object.keys(spread)).toEqual(["dc.obj.a1"])
  })

  it("摊开再读回来是恒等的", () => {
    const objects = [
      { uuid: "a1", pose: { elbow: 43 } },
      { uuid: "a2", pose: { elbow: 12 } }
    ]
    const found = readCollection(data(spreadCollection(PREFIX, objects, (o) => o.uuid)), PREFIX)

    expect([...found.values()]).toEqual(objects)
  })
})
