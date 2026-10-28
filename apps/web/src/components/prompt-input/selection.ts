/**
 * contenteditable DOM 与模型之间的选区桥接层。
 *
 * DOM 约定（镜像 slate-react）：
 *   - 每个段落块：<div data-block-path="[bi]">
 *   - 每个文本叶包裹器：
 *       <span data-slate-node="text">
 *         <span data-slate-leaf="true" data-leaf-path="[bi,ii]">
 *           <span data-slate-string="true">…text…</span>      ← 非空
 *           OR
 *           <span data-slate-zero-width="z|n" data-slate-length="0">
 *             U+FEFF
 *           </span>
 *         </span>
 *       </span>
 *   - 每个 mention（void）：<span data-void-path="[bi,ii]" contenteditable="false">@…</span>
 *
 * 光标只存在于文本叶内部。当文本叶为空时，光标位于零宽 span 的 FEFF
 * 文本节点上；我们需要将其映射回模型 offset 0（FEFF 仅用于展示）。
 */
import type { Path, Point } from "./types"
import type { Range as ModelRange } from "./types"
import { RangeCreate } from "./operations"

type DOMRange = Range

export const findLeafElement = (
  root: HTMLElement,
  path: Path
): HTMLElement | null => {
  const attr = JSON.stringify(path)
  return root.querySelector<HTMLElement>(`[data-leaf-path="${attr}"]`)
}

export const findBlockElement = (
  root: HTMLElement,
  path: Path
): HTMLElement | null => {
  const attr = JSON.stringify(path)
  return root.querySelector<HTMLElement>(`[data-block-path="${attr}"]`)
}

/**
 * 定位 DOM 中支撑文本叶的实际文本节点，考虑 slate 风格的嵌套包裹器。
 * 返回文本节点及一个标志，指示是否为零宽填充符（FEFF）。
 */
const getLeafTextAnchor = (
  leafEl: HTMLElement
): { node: Text; isZeroWidth: boolean } | null => {
  // 优先选择 [data-slate-string] 内层 span——真实文本存放在这里。
  const stringEl = leafEl.querySelector<HTMLElement>("[data-slate-string]")
  if (stringEl) {
    let tn = stringEl.firstChild as Text | null
    if (!tn || tn.nodeType !== Node.TEXT_NODE) {
      tn = document.createTextNode("")
      stringEl.insertBefore(tn, stringEl.firstChild)
    }
    return { node: tn, isZeroWidth: false }
  }
  // 否则是零宽填充符。
  const zeroEl = leafEl.querySelector<HTMLElement>("[data-slate-zero-width]")
  if (zeroEl) {
    let tn = zeroEl.firstChild as Text | null
    // 零宽 span 包含单个 FEFF 文本节点。
    if (!tn || tn.nodeType !== Node.TEXT_NODE) {
      tn = document.createTextNode("\uFEFF")
      zeroEl.insertBefore(tn, zeroEl.firstChild)
    }
    return { node: tn, isZeroWidth: true }
  }
  return null
}

/** 将模型 Point 转换为 DOM (Node, offset) 元组。 */
export const toDOMPoint = (
  root: HTMLElement,
  point: Point
): { node: Node; offset: number } | null => {
  const leaf = findLeafElement(root, point.path)
  if (leaf) {
    const anchor = getLeafTextAnchor(leaf)
    if (!anchor) {
      return { node: leaf, offset: 0 }
    }
    if (anchor.isZeroWidth) {
      // 空文本叶：光标位于 FEFF 字符之前。
      return { node: anchor.node, offset: 0 }
    }
    const len = anchor.node.textContent?.length ?? 0
    return {
      node: anchor.node,
      offset: Math.max(0, Math.min(point.offset, len))
    }
  }
  // 兜底：文本叶尚未渲染——锚定到块中。
  const block = findBlockElement(root, point.path.slice(0, -1))
  if (block) return { node: block, offset: 0 }
  return null
}

/** 将 DOM (Node, offset) 元组转换回模型 Point。 */
export const toModelPoint = (
  root: HTMLElement,
  node: Node,
  offset: number
): Point | null => {
  // 情况 1：光标在文本节点上——向上查找到最近的文本叶，
  // 判断是零宽填充符还是真实字符串。
  if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
    const leafEl = node.parentElement.closest(
      "[data-leaf-path]"
    ) as HTMLElement | null
    if (leafEl) {
      const path = JSON.parse(
        leafEl.getAttribute("data-leaf-path") ?? "null"
      ) as Path | null
      if (path) {
        // 如果父节点（或到文本叶的任何祖先）是零宽 span，
        // 则模型中文本叶为空——将 offset 钳制为 0。
        const isZeroWidth = !!node.parentElement.closest(
          "[data-slate-zero-width]"
        )
        if (isZeroWidth) {
          return { path, offset: 0 }
        }
        const len = node.textContent?.length ?? 0
        return { path, offset: Math.min(offset, len) }
      }
    }
  }

  // 情况 2：光标在元素节点上。
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement

    // 2·root：光标直接锚定在 contenteditable 根元素上。
    // Firefox 在无法解析精确位置时（通常是点击空行或块之间的模糊区域）
    // 以这种方式报告选区，`offset` = 块索引。
    // 没有此分支 toModelPoint 会返回 null（block-div 是 root 的子节点，
    // 但 root 自身不带 slate 属性），模型选区不会从点击更新，
    // 下一个按键会落在之前存储的光标位置。
    if (el === root) {
      const blocks = Array.from(root.children) as HTMLElement[]
      if (blocks.length > 0) {
        const clamped = Math.min(Math.max(offset, 0), blocks.length - 1)
        const atEnd = offset >= blocks.length
        const targetBlock = blocks[clamped]!
        const leafEl =
          targetBlock.querySelector<HTMLElement>("[data-leaf-path]")
        if (leafEl) {
          const path = JSON.parse(
            leafEl.getAttribute("data-leaf-path") ?? "null"
          ) as Path | null
          if (path) {
            if (atEnd) {
              const a = getLeafTextAnchor(leafEl)
              if (!a || a.isZeroWidth) return { path, offset: 0 }
              return { path, offset: a.node.textContent?.length ?? 0 }
            }
            return { path, offset: 0 }
          }
        }
      }
    }

    // 2a：光标在文本叶包裹器或其后代内部但不在文本节点上——
    // 解析为文本叶的文本锚点。
    const leafAncestor = el.closest("[data-leaf-path]") as HTMLElement | null
    if (leafAncestor) {
      const path = JSON.parse(
        leafAncestor.getAttribute("data-leaf-path") ?? "null"
      ) as Path | null
      if (path) {
        const anchor = getLeafTextAnchor(leafAncestor)
        if (!anchor || anchor.isZeroWidth) {
          return { path, offset: 0 }
        }
        const len = anchor.node.textContent?.length ?? 0
        // 此处的 offset 是 childNodes 中的索引——尽力映射到
        // 文本长度（offset > 0 时），否则为 0。
        return { path, offset: offset > 0 ? len : 0 }
      }
    }

    // 2b：光标在 void（mention）上——转换为相邻的文本叶。
    const voidAncestor = el.closest("[data-void-path]") as HTMLElement | null
    if (voidAncestor) {
      const path = JSON.parse(
        voidAncestor.getAttribute("data-void-path") ?? "null"
      ) as Path | null
      if (path) {
        return resolveAroundInline(root, path, offset > 0 ? "after" : "before")
      }
    }

    // 2c：光标在块 <div> 的子节点之间。
    const blockAncestor = el.closest("[data-block-path]") as HTMLElement | null
    if (blockAncestor && el === blockAncestor) {
      const blockPath = JSON.parse(
        el.getAttribute("data-block-path") ?? "null"
      ) as Path | null
      if (blockPath) {
        const bi = blockPath[0] ?? 0
        const child = el.children[offset] as HTMLElement | undefined
        if (child) {
          // 可能是文本包裹器或 void。
          const innerLeaf = child.querySelector?.(
            "[data-leaf-path]"
          ) as HTMLElement | null
          if (innerLeaf) {
            const path = JSON.parse(
              innerLeaf.getAttribute("data-leaf-path") ?? "null"
            ) as Path | null
            if (path) return { path, offset: 0 }
          }
          const voidPath = child.getAttribute("data-void-path")
          if (voidPath) {
            return resolveAroundInline(
              root,
              JSON.parse(voidPath) as Path,
              "before"
            )
          }
          // `offset` 处的子节点不是已识别的 slate 元素（例如 Firefox
          // 在触发 Enter 的 beforeinput 之前注入的 <br>）。
          // 锚定到左侧最近已识别文本叶的末尾。
          for (let i = offset - 1; i >= 0; i--) {
            const prev = el.children[i] as HTMLElement
            const prevLeaf = prev.querySelector?.(
              "[data-leaf-path]"
            ) as HTMLElement | null
            if (prevLeaf) {
              const path = JSON.parse(
                prevLeaf.getAttribute("data-leaf-path") ?? "null"
              ) as Path | null
              if (path) {
                const a = getLeafTextAnchor(prevLeaf)
                if (!a || a.isZeroWidth) return { path, offset: 0 }
                return { path, offset: a.node.textContent?.length ?? 0 }
              }
            }
            const prevVoid = prev.getAttribute("data-void-path")
            if (prevVoid) {
              return resolveAroundInline(
                root,
                JSON.parse(prevVoid) as Path,
                "after"
              )
            }
          }
        }
        // 超过最后一个子节点：锚定到块中最后已识别的 slate 文本叶末尾。
        // 向后搜索以跳过浏览器注入的元素（例如 Firefox 在触发
        // Enter 的 beforeinput 之前插入的 <br>）。
        if (offset >= el.children.length && el.children.length > 0) {
          for (let i = el.children.length - 1; i >= 0; i--) {
            const cand = el.children[i] as HTMLElement
            const innerLeaf =
              cand.querySelector<HTMLElement>("[data-leaf-path]")
            if (innerLeaf) {
              const path = JSON.parse(
                innerLeaf.getAttribute("data-leaf-path") ?? "null"
              ) as Path | null
              if (path) {
                const a = getLeafTextAnchor(innerLeaf)
                if (!a || a.isZeroWidth) return { path, offset: 0 }
                return { path, offset: a.node.textContent?.length ?? 0 }
              }
            }
            const voidPath = cand.getAttribute("data-void-path")
            if (voidPath) {
              return resolveAroundInline(
                root,
                JSON.parse(voidPath) as Path,
                "after"
              )
            }
          }
        }
        return { path: [bi, 0], offset: 0 }
      }
    }
  }

  // 情况 3：向上查找文本叶/void；记录所属块。
  let cur: HTMLElement | null =
    node.nodeType === Node.TEXT_NODE
      ? (node.parentElement ?? null)
      : (node as HTMLElement)
  let enclosingBlock: HTMLElement | null = null
  while (cur && cur !== root) {
    const lp = cur.getAttribute("data-leaf-path")
    if (lp) {
      const path = JSON.parse(lp) as Path
      const a = getLeafTextAnchor(cur)
      if (!a || a.isZeroWidth) return { path, offset: 0 }
      return { path, offset: a.node.textContent?.length ?? 0 }
    }
    const vp = cur.getAttribute("data-void-path")
    if (vp) {
      const path = JSON.parse(vp) as Path
      return resolveAroundInline(root, path, "after")
    }
    if (!enclosingBlock && cur.getAttribute("data-block-path"))
      enclosingBlock = cur
    cur = cur.parentElement
  }

  // 情况 4：光标位于不属于任何文本叶的节点上——这是 Firefox 注入的
  // *游离节点*（例如点击空行时创建的空文本节点，或编辑过程中的虚假节点）。
  // 不返回 null（那会使模型选区过期并将下一个按键发送到之前的光标位置），
  // 而是解析到最近的文本叶。
  const block = enclosingBlock ?? nearestBlockForNode(root, node)
  if (block) {
    const p = pointInBlockNearNode(block, node)
    if (p) return p
  }
  return null
}

/**
 * 返回 `block` 内的模型 Point，定位到文档顺序中最接近 `node` 的文本叶
 * （若 `node` 在文本叶之后则光标在该叶末尾，否则在开头）。
 * 用于从游离/外来 DOM 节点恢复。
 */
const pointInBlockNearNode = (block: HTMLElement, node: Node): Point | null => {
  const leaves = Array.from(
    block.querySelectorAll<HTMLElement>("[data-leaf-path]")
  )
  if (leaves.length === 0) return null
  let chosen = leaves[0]!
  let atEnd = false
  for (const leaf of leaves) {
    // node 在 leaf 之后 → 继续前进；否则停止。
    if (leaf.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
      chosen = leaf
      atEnd = true
    } else {
      break
    }
  }
  const path = JSON.parse(
    chosen.getAttribute("data-leaf-path") ?? "null"
  ) as Path | null
  if (!path) return null
  const a = getLeafTextAnchor(chosen)
  if (!a || a.isZeroWidth) return { path, offset: 0 }
  return { path, offset: atEnd ? (a.node.textContent?.length ?? 0) : 0 }
}

/**
 * 当 `node` 不在任何块内部时（例如 contenteditable 根部的游离文本节点），
 * 找到 `node` 最可能所属的块元素：文档顺序中 `node` 之后的最后一个块，
 * 否则返回第一个块。
 */
const nearestBlockForNode = (
  root: HTMLElement,
  node: Node
): HTMLElement | null => {
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>("[data-block-path]")
  )
  if (blocks.length === 0) return null
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (
      blocks[i]!.compareDocumentPosition(node) &
      Node.DOCUMENT_POSITION_FOLLOWING
    ) {
      return blocks[i]!
    }
  }
  return blocks[0]!
}

/** 找到 void（mention）相邻的文本叶并返回其上的 Point。 */
const resolveAroundInline = (
  root: HTMLElement,
  voidPath: Path,
  side: "before" | "after"
): Point | null => {
  const block = findBlockElement(root, voidPath.slice(0, -1))
  if (!block) return null
  const targetAttr = JSON.stringify(voidPath)
  const children = Array.from(block.children) as HTMLElement[]
  const idx = children.findIndex(
    (c) => c.getAttribute("data-void-path") === targetAttr
  )
  if (idx < 0) return null
  const findLeafIn = (el: HTMLElement) =>
    el.querySelector?.("[data-leaf-path]") as HTMLElement | null
  if (side === "before") {
    for (let i = idx - 1; i >= 0; i--) {
      const leafEl =
        children[i]!.getAttribute("data-leaf-path") !== null
          ? children[i]!
          : findLeafIn(children[i]!)
      if (leafEl && leafEl.getAttribute("data-leaf-path")) {
        const path = JSON.parse(
          leafEl.getAttribute("data-leaf-path") ?? "null"
        ) as Path
        const a = getLeafTextAnchor(leafEl)
        if (!a || a.isZeroWidth) return { path, offset: 0 }
        return { path, offset: a.node.textContent?.length ?? 0 }
      }
    }
  } else {
    for (let i = idx + 1; i < children.length; i++) {
      const leafEl =
        children[i]!.getAttribute("data-leaf-path") !== null
          ? children[i]!
          : findLeafIn(children[i]!)
      if (leafEl && leafEl.getAttribute("data-leaf-path")) {
        const path = JSON.parse(
          leafEl.getAttribute("data-leaf-path") ?? "null"
        ) as Path
        return { path, offset: 0 }
      }
    }
  }
  return null
}

/** 将模型 Range 转换为 DOM Range。 */
export const toDOMRange = (
  root: HTMLElement,
  range: ModelRange
): DOMRange | null => {
  const a = toDOMPoint(root, range.anchor)
  const b = toDOMPoint(root, range.focus)
  if (!a || !b) return null
  const r = new Range()
  try {
    r.setStart(a.node, a.offset)
    r.setEnd(b.node, b.offset)
  } catch {
    return null
  }
  return r
}

/** 将模型 Range 应用到文档选区。 */
export const applyDOMRange = (
  root: HTMLElement,
  range: ModelRange | null
): void => {
  const sel = window.getSelection()
  if (!sel) return
  if (!range) {
    sel.removeAllRanges()
    return
  }
  const a = toDOMPoint(root, range.anchor)
  const b = toDOMPoint(root, range.focus)
  if (!a || !b) return
  try {
    // setBaseAndExtent 按 anchor→focus 写入，保留选区方向。
    // addRange(Range) 只能表达正向选区：DOM Range 的 setStart 在 end
    // 之后时会把 range 折叠，反向（anchor 在文档后方）的模型选区
    // 写回 DOM 时会被吞掉，Firefox 下拖选锚点随之丢失。
    sel.setBaseAndExtent(a.node, a.offset, b.node, b.offset)
  } catch {
    // Chrome 抛出 "Cannot read properties of null (reading 'nextSibling')"
    // 当 range 引用了被并发 DOM 更新分离的节点时。
  }
}

/** 从 DOM 读取当前选区并转换为模型 Range。 */
export const readModelRange = (root: HTMLElement): ModelRange | null => {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  // 读 selection 的 anchor/focus 而非 getRangeAt(0) 的 start/end：
  //   1. start/end 丢失方向，反向拖选会被当成正向选区存入模型；
  //   2. Firefox 会把跨越 contenteditable=false inline（mention/{{...}}）
  //      的选区拆成多个 Range，getRangeAt(0) 只覆盖 void 之前的第一段，
  //      anchor/focus 才是整个选区的真实两端。
  const { anchorNode, focusNode } = sel
  if (!anchorNode || !focusNode) return null
  if (!root.contains(anchorNode) || !root.contains(focusNode)) return null
  const anchor = toModelPoint(root, anchorNode, sel.anchorOffset)
  const focus = toModelPoint(root, focusNode, sel.focusOffset)
  if (!anchor || !focus) return null
  return RangeCreate(anchor, focus)
}
