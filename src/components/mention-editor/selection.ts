/**
 * Selection bridge between the contenteditable DOM and the model.
 *
 * Conventions in our DOM:
 *   - Every paragraph block: <div data-block-path="[bi]">
 *   - Every text leaf:       <span data-leaf-path="[bi,ii]">…text…</span>
 *   - Every mention (void):  <span data-void-path="[bi,ii]" contenteditable="false">@…</span>
 *
 * The caret only ever sits inside text leaves (and their child text node).
 * Mentions are inline voids — the browser will skip past them when the
 * caret moves, landing in the surrounding empty text leaf.
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

export const findVoidElement = (
  root: HTMLElement,
  path: Path
): HTMLElement | null => {
  const attr = JSON.stringify(path)
  return root.querySelector<HTMLElement>(`[data-void-path="${attr}"]`)
}

export const findBlockElement = (
  root: HTMLElement,
  path: Path
): HTMLElement | null => {
  const attr = JSON.stringify(path)
  return root.querySelector<HTMLElement>(`[data-block-path="${attr}"]`)
}

/** Convert a model Point to a DOM (Node, offset) tuple. */
export const toDOMPoint = (
  root: HTMLElement,
  point: Point
): { node: Node; offset: number } | null => {
  const leaf = findLeafElement(root, point.path)
  if (leaf) {
    // Ensure we have a text node child to anchor on.
    let tn = leaf.firstChild
    if (!tn || tn.nodeType !== Node.TEXT_NODE) {
      // Empty leaf — create a placeholder text node so a caret can
      // land here.  This is safe; Vue keeps innerText in sync via the
      // template, and the empty text node we add is harmless.
      const empty = document.createTextNode("")
      leaf.insertBefore(empty, leaf.firstChild)
      tn = empty
    }
    const len = tn.textContent?.length ?? 0
    return { node: tn, offset: Math.max(0, Math.min(point.offset, len)) }
  }
  // Fallback: the leaf hasn't rendered yet — anchor in the block.
  const block = findBlockElement(root, point.path.slice(0, -1))
  if (block) return { node: block, offset: 0 }
  return null
}

/** Convert a DOM (Node, offset) tuple back to a model Point. */
export const toModelPoint = (
  root: HTMLElement,
  node: Node,
  offset: number
): Point | null => {
  // Case 1: caret is on a text node inside a leaf span.
  if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
    const leafEl = node.parentElement.closest(
      "[data-leaf-path]"
    ) as HTMLElement | null
    if (leafEl) {
      const path = JSON.parse(
        leafEl.getAttribute("data-leaf-path") ?? "null"
      ) as Path | null
      if (path) {
        const len = node.textContent?.length ?? 0
        return { path, offset: Math.min(offset, len) }
      }
    }
  }

  // Case 2: caret on a leaf span itself (no text node).
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement
    const lp = el.getAttribute("data-leaf-path")
    if (lp) {
      const path = JSON.parse(lp) as Path
   const tn = el.firstChild
      const len = tn?.textContent?.length ?? 0
      // offset here is the index among childNodes (0 or 1 typically).
      // We map it to the text length when offset > 0, else 0.
      return { path, offset: offset > 0 ? len : 0 }
    }

    // Case 3: caret on a void (mention) — translate to neighbouring
    // text leaf.
    const vp = el.getAttribute("data-void-path")
    if (vp) {
      const path = JSON.parse(vp) as Path
      // Heuristic: place caret at the START of the next leaf if offset
      // is non-zero, else at end of previous.  But callers usually
      // shouldn't land here; handle as best-effort.
      return resolveAroundInline(root, path, offset > 0 ? "after" : "before")
    }

    // Case 4: caret on a block <div> between children.
    const bp = el.getAttribute("data-block-path")
    if (bp) {
      const blockPath = JSON.parse(bp) as Path
      const bi = blockPath[0] ?? 0
      const child = el.children[offset]
      if (child) {
        const lp2 = child.getAttribute("data-leaf-path")
        if (lp2) {
          const path = JSON.parse(lp2) as Path
          return { path, offset: 0 }
        }
        const vp2 = child.getAttribute("data-void-path")
        if (vp2) {
          const path = JSON.parse(vp2) as Path
          return resolveAroundInline(root, path, "before")
        }
      }
      // Past last child:
      if (offset >= el.children.length && el.children.length > 0) {
        const last = el.children[el.children.length - 1] as HTMLElement
        const lp2 = last.getAttribute("data-leaf-path")
        if (lp2) {
          const path = JSON.parse(lp2) as Path
          const tn = last.firstChild
          return { path, offset: tn?.textContent?.length ?? 0 }
        }
        const vp2 = last.getAttribute("data-void-path")
        if (vp2) {
          const path = JSON.parse(vp2) as Path
          return resolveAroundInline(root, path, "after")
        }
      }
      return { path: [bi, 0], offset: 0 }
    }
  }

  // Case 5: walk up looking for a leaf/void.
  let cur: HTMLElement | null =
    node.nodeType === Node.TEXT_NODE
      ? (node.parentElement ?? null)
      : (node as HTMLElement)
  while (cur && cur !== root) {
    const lp = cur.getAttribute("data-leaf-path")
    if (lp) {
      const path = JSON.parse(lp) as Path
      return { path, offset: cur.firstChild?.textContent?.length ?? 0 }
    }
    const vp = cur.getAttribute("data-void-path")
    if (vp) {
      const path = JSON.parse(vp) as Path
      return resolveAroundInline(root, path, "after")
    }
    cur = cur.parentElement
  }
  return null
}

/** Find a text leaf adjacent to a void (mention) and return a Point on it. */
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
  if (side === "before") {
    for (let i = idx - 1; i >= 0; i--) {
      const lp = children[i]!.getAttribute("data-leaf-path")
      if (lp) {
        const path = JSON.parse(lp) as Path
        const tn = children[i]!.firstChild
        return { path, offset: tn?.textContent?.length ?? 0 }
      }
    }
  } else {
    for (let i = idx + 1; i < children.length; i++) {
      const lp = children[i]!.getAttribute("data-leaf-path")
      if (lp) {
        const path = JSON.parse(lp) as Path
        return { path, offset: 0 }
      }
    }
  }
  return null
}

/** Convert a model Range to a DOM Range. */
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

/** Apply a model Range to the document's selection. */
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
  const dom = toDOMRange(root, range)
  if (!dom) return
  sel.removeAllRanges()
  sel.addRange(dom)
}

/** Read the current selection from the DOM and convert to a model Range. */
export const readModelRange = (root: HTMLElement): ModelRange | null => {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const dom = sel.getRangeAt(0)
  if (!root.contains(dom.startContainer)) return null
  const anchor = toModelPoint(root, dom.startContainer, dom.startOffset)
  const focus = toModelPoint(root, dom.endContainer, dom.endOffset)
  if (!anchor || !focus) return null
  return RangeCreate(anchor, focus)
}