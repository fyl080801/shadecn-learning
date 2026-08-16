import { describe, expect, it } from "vitest"

import {
  elementIdOf,
  elementKey,
  lockOwner,
  lockedKeys,
  occupiedBy,
  occupies,
  presenceColor,
  presenceInitials,
  readPeer,
  readPeers,
  remoteTransforms,
  type PresencePeer
} from "@/lib/presence"

/** 拼一个 awareness 状态；测试里只关心 user 之外那几个字段 */
function state(id: string, extra: Record<string, unknown> = {}) {
  return { user: { id, name: id }, ...extra }
}

function peer(
  clientId: number,
  overrides: Partial<
    Pick<PresencePeer, "selection" | "transform" | "connecting" | "isSelf">
  > = {}
): PresencePeer {
  return {
    clientId,
    user: { id: `u${clientId}`, name: `u${clientId}`, avatarUrl: null, color: "#000" },
    cursor: null,
    selection: overrides.selection ?? new Set(),
    transform: overrides.transform ?? new Map(),
    connecting: overrides.connecting ?? null,
    isSelf: overrides.isSelf ?? false
  }
}

/** 正从某个节点拉线的人（还没松手） */
function connectingFrom(clientId: number, nodeId: string) {
  return peer(clientId, { connecting: { from: { x: 0, y: 0 }, nodeId } })
}

/** 选中了某个节点的人 */
function selecting(clientId: number, nodeId: string, isSelf = false) {
  return peer(clientId, { selection: new Set([elementKey("node", nodeId)]), isSelf })
}

/** 正拖着某个节点的人 */
function dragging(clientId: number, nodeId: string, x = 0, y = 0, isSelf = false) {
  return peer(clientId, {
    transform: new Map([[elementKey("node", nodeId), { x, y }]]),
    isSelf
  })
}

describe("元素 key", () => {
  it("节点和边各自成域，不会串", () => {
    expect(elementKey("node", "a")).not.toBe(elementKey("edge", "a"))
  })

  it("能取回 id，种类对不上给 null", () => {
    expect(elementIdOf(elementKey("node", "n1"), "node")).toBe("n1")
    expect(elementIdOf(elementKey("edge", "e1"), "node")).toBeNull()
  })
})

describe("presenceColor", () => {
  it("同一个 id 每次都是同一个颜色", () => {
    expect(presenceColor("user-a")).toBe(presenceColor("user-a"))
  })

  it("颜色一定来自配色表", () => {
    for (const id of ["a", "bb", "ccc", "用户", ""]) {
      expect(presenceColor(id)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})

describe("presenceInitials", () => {
  it("中文名取最后一个字", () => {
    expect(presenceInitials("张三")).toBe("三")
    expect(presenceInitials("欧阳锋")).toBe("锋")
  })

  it("西文名取首字母并大写", () => {
    expect(presenceInitials("alice")).toBe("A")
    expect(presenceInitials("Bob Smith")).toBe("B")
  })

  it("空名字兜底成问号", () => {
    expect(presenceInitials("   ")).toBe("?")
  })
})

describe("readPeer", () => {
  it("没有 user 字段的状态整条丢掉", () => {
    expect(readPeer(1, { cursor: { x: 1, y: 2 } }, false)).toBeNull()
    expect(readPeer(1, null, false)).toBeNull()
    expect(readPeer(1, "不是对象", false)).toBeNull()
  })

  it("坏掉的 cursor 只丢 cursor，人还在", () => {
    const parsed = readPeer(1, state("u1", { cursor: { x: "10", y: 2 } }), false)
    expect(parsed?.cursor).toBeNull()
    expect(parsed?.user.id).toBe("u1")
  })

  it("NaN / Infinity 的坐标不当有效光标", () => {
    expect(readPeer(1, state("u1", { cursor: { x: NaN, y: 0 } }), false)?.cursor).toBeNull()
    expect(readPeer(1, state("u1", { cursor: { x: 0, y: Infinity } }), false)?.cursor).toBeNull()
  })

  it("颜色按 id 本地重算，不信客户端上报的那个", () => {
    const parsed = readPeer(1, { user: { id: "u1", name: "u1", color: "#123456" } }, false)
    expect(parsed?.user.color).toBe(presenceColor("u1"))
  })

  it("缺名字时兜底成匿名用户", () => {
    expect(readPeer(1, { user: { id: "u1" } }, false)?.user.name).toBe("匿名用户")
  })

  it("选中列表里的非字符串项被剔掉", () => {
    const parsed = readPeer(1, state("u1", { selection: ["node:a", 42, "", null] }), false)
    expect([...(parsed?.selection ?? [])]).toEqual(["node:a"])
  })

  it("selection 不是数组时退回空集合，而不是让整条状态失效", () => {
    const parsed = readPeer(1, state("u1", { selection: "node:a" }), false)
    expect(parsed?.selection.size).toBe(0)
    expect(parsed?.user.id).toBe("u1")
  })

  it("connecting 缺 nodeId 或坐标坏掉就整条丢掉", () => {
    expect(readPeer(1, state("u1", { connecting: { from: { x: 1, y: 2 } } }), false)?.connecting)
      .toBeNull()
    expect(readPeer(1, state("u1", { connecting: { nodeId: "n1" } }), false)?.connecting)
      .toBeNull()
    expect(
      readPeer(1, state("u1", { connecting: { from: { x: 1, y: 2 }, nodeId: "n1" } }), false)
        ?.connecting
    ).toEqual({ from: { x: 1, y: 2 }, nodeId: "n1" })
  })

  it("transform 里坏掉的几何被剔掉，好的留下", () => {
    const parsed = readPeer(
      1,
      state("u1", { transform: { "node:a": { x: 1, y: 2 }, "node:b": { x: "1", y: 2 } } }),
      false
    )
    expect([...(parsed?.transform.keys() ?? [])]).toEqual(["node:a"])
  })
})

describe("readPeers", () => {
  it("自己排第一，其余按 clientId 稳定排序", () => {
    const states = new Map<number, unknown>([
      [9, state("u9")],
      [3, state("u3")],
      [7, state("u7")]
    ])
    expect(readPeers(states, 7).map((p) => p.clientId)).toEqual([7, 3, 9])
  })

  it("解析不出来的客户端直接跳过，不影响别人", () => {
    const states = new Map<number, unknown>([
      [1, state("u1")],
      [2, {}],
      [3, state("u3")]
    ])
    expect(readPeers(states, 1).map((p) => p.clientId)).toEqual([1, 3])
  })
})

describe("占用判定", () => {
  it("选中算占用，正在拖也算占用", () => {
    expect(occupies(selecting(1, "n1"), elementKey("node", "n1"))).toBe(true)
    expect(occupies(dragging(1, "n1"), elementKey("node", "n1"))).toBe(true)
    expect(occupies(peer(1), elementKey("node", "n1"))).toBe(false)
  })

  it("正从一个节点拉线（还没松手）也算在编辑那个节点", () => {
    const puller = connectingFrom(1, "n1")
    expect(occupies(puller, elementKey("node", "n1"))).toBe(true)
    // 只占起点，别的节点不受影响
    expect(occupies(puller, elementKey("node", "n2"))).toBe(false)
  })

  it("occupiedBy 把选中、拖动、拉线起点并起来，去重", () => {
    const busy = peer(1, {
      selection: new Set([elementKey("node", "n1")]),
      transform: new Map([
        [elementKey("node", "n1"), { x: 0, y: 0 }],
        [elementKey("node", "n2"), { x: 0, y: 0 }]
      ]),
      connecting: { from: { x: 0, y: 0 }, nodeId: "n3" }
    })
    expect([...occupiedBy(busy)].sort()).toEqual(["node:n1", "node:n2", "node:n3"])
  })

  it("节点和边互不干扰：选中 node:a 不会锁住 edge:a", () => {
    const peers = [selecting(1, "a")]
    expect(lockOwner(peers, elementKey("node", "a"), 2)?.clientId).toBe(1)
    expect(lockOwner(peers, elementKey("edge", "a"), 2)).toBeNull()
  })

  it("边同样能被占用，规则和节点一致", () => {
    const holder = peer(1, { selection: new Set([elementKey("edge", "e1")]) })
    expect(lockOwner([holder], elementKey("edge", "e1"), 2)?.clientId).toBe(1)
    expect(lockOwner([holder], elementKey("edge", "e1"), 1)).toBeNull()
  })
})

describe("lockOwner", () => {
  it("别人选中的元素归别人", () => {
    const peers = [selecting(1, "n1", true), selecting(2, "n1")]
    // clientId 小的赢：1 是我自己，所以对我来说它可编辑，对 2 来说它被占了
    expect(lockOwner(peers, elementKey("node", "n1"), 1)).toBeNull()
    expect(lockOwner(peers, elementKey("node", "n1"), 2)?.clientId).toBe(1)
  })

  it("同时抢一个元素时 clientId 最小者胜，且各端结论一致", () => {
    const peers = [selecting(5, "n1"), selecting(2, "n1"), selecting(9, "n1")]
    expect(lockOwner(peers, elementKey("node", "n1"), 5)?.clientId).toBe(2)
    expect(lockOwner(peers, elementKey("node", "n1"), 9)?.clientId).toBe(2)
    expect(lockOwner(peers, elementKey("node", "n1"), 2)).toBeNull()
  })

  it("拖动者和选中者抢同一个节点，同样按 clientId 判", () => {
    const peers = [dragging(7, "n1"), selecting(3, "n1")]
    expect(lockOwner(peers, elementKey("node", "n1"), 7)?.clientId).toBe(3)
  })

  it("没人占就没人锁", () => {
    expect(lockOwner([selecting(1, "n2")], elementKey("node", "n1"), 1)).toBeNull()
  })
})

describe("lockedKeys", () => {
  it("只收别人占住的，我自己选的不在里面", () => {
    const peers = [selecting(1, "mine", true), selecting(2, "theirs")]
    expect([...lockedKeys(peers, 1)]).toEqual(["node:theirs"])
  })

  it("抢输了的话我选的那个也会被算进来", () => {
    // 我是 5，对方是 2，两人都选了 n1 —— 按最小者胜，n1 对我是只读的
    const peers = [selecting(5, "n1", true), selecting(2, "n1")]
    expect(lockedKeys(peers, 5).has("node:n1")).toBe(true)
  })

  it("别人正在拖的节点也是只读的（不然会被两个人同时搬）", () => {
    expect(lockedKeys([dragging(2, "n1")], 1).has("node:n1")).toBe(true)
  })

  it("别人正拉线的起点节点也是只读的", () => {
    expect(lockedKeys([connectingFrom(2, "n1")], 1).has("node:n1")).toBe(true)
  })
})

describe("remoteTransforms", () => {
  it("给出别人拖动中的实时几何，不含我自己的", () => {
    const peers = [dragging(1, "mine", 10, 10, true), dragging(2, "theirs", 30, 40)]
    const geometry = remoteTransforms(peers, 1)
    expect(geometry.get("node:theirs")).toEqual({ x: 30, y: 40 })
    expect(geometry.has("node:mine")).toBe(false)
  })

  it("同一个元素被多人上报时取 clientId 最小者，和 lockOwner 一把尺子", () => {
    const peers = [dragging(9, "n1", 90, 90), dragging(4, "n1", 40, 40)]
    expect(remoteTransforms(peers, 1).get("node:n1")).toEqual({ x: 40, y: 40 })
  })
})
