import { describe, expect, it } from "vitest"
import { directorShortcutOf } from "@/components/director/directorShortcuts"

/** 导演台自己的快捷键映射（路由在全屏层，见 FlowDirectorOverlay.test.ts） */
const key = (init: KeyboardEventInit) => directorShortcutOf(new KeyboardEvent("keydown", init))

describe("导演台快捷键", () => {
  it("Delete / Backspace 删除，空格播放 / 暂停", () => {
    expect(key({ key: "Delete" })).toBe("delete")
    expect(key({ key: "Backspace" })).toBe("delete")
    expect(key({ key: " " })).toBe("toggle-play")
  })

  it("Mod+Z 撤销，Mod+Shift+Z 和 Mod+Y 重做（Meta 或 Ctrl）", () => {
    expect(key({ key: "z", ctrlKey: true })).toBe("undo")
    expect(key({ key: "z", metaKey: true })).toBe("undo")
    expect(key({ key: "Z", metaKey: true, shiftKey: true })).toBe("redo")
    expect(key({ key: "y", ctrlKey: true })).toBe("redo")
  })

  it("别的组合不归导演台", () => {
    expect(key({ key: "a" })).toBeNull()
    expect(key({ key: "Delete", altKey: true })).toBeNull()
    expect(key({ key: "s", ctrlKey: true })).toBeNull()
    expect(key({ key: "z", ctrlKey: true, altKey: true })).toBeNull()
  })
})
