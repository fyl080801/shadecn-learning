/**
 * Selection bridge between the contenteditable DOM and the model.
 *
 * Conventions in our DOM (mirrors slate-react):
 *   - Every paragraph block: <div data-block-path="[bi]">
 *   - Every text leaf wrapper:
 *       <span data-slate-node="text">
 *         <span data-slate-leaf="true" data-leaf-path="[bi,ii]">
 *           <span data-slate-string="true">…text…</span>      ← non-empty
 *           OR
 *           <span data-slate-zero-width="z|n" data-slate-length="0">
 *             ﻿ (U+FEFF) [+ <br/> if "n"]
 *           </span>
 *         </span>
 *       </span>
 *   - Every mention (void):  <span data-void-path="[bi,ii]" contenteditable="false">@…</span>
 *
 * The caret only ever sits inside text leaves.  When the leaf is empty
 * the caret lives on the zero-width span's FEFF text node; we must map
 * that back to model offset 0 (the FEFF is a presentation-only filler).
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

/**
 * Locate the actual text node that backs a leaf in the DOM, taking
 * the slate-style nested wrappers into account.  Returns the text node
 * plus a flag telling whether it's a zero-width filler (FEFF).
 */
const getLeafTextAnchor = (
  leafEl: HTMLElement
): { node: Text; isZeroWidth: boolean } | null => {
  // Prefer the [data-slate-string] inner span — that's where real text
  // lives.
  const stringEl = leafEl.querySelector<HTMLElement>("[data-slate-string]")
  if (stringEl) {
    let tn = stringEl.firstChild as Text | null
    if (!tn || tn.nodeType !== Node.TEXT_NODE) {
      tn = document.createTextNode("")
      stringEl.insertBefore(tn, stringEl.firstChild)
    }
    return { node: tn, isZeroWidth: false }
  }
  // Otherwise it's a zero-width filler.
  const zeroEl = leafEl.querySelector<HTMLElement>("[data-slate-zero-width]")
  if (zeroEl) {
    let tn = zeroEl.firstChild as Text | null
    // The zero-width span contains a FEFF text node (and optionally a <br>).
    if (!tn || tn.nodeType !== Node.TEXT_NODE) {
      tn = document.createTextNode("\uFEFF")
      zeroEl.insertBefore(tn, zeroEl.firstChild)
    }
    return { node: tn, isZeroWidth: true }
  }
  return null
}

/** Convert a model Point to a DOM (Node, offset) tuple. */
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
      // Empty leaf: caret sits before the FEFF char.
      return { node: anchor.node, offset: 0 }
    }
    const len = anchor.node.textContent?.length ?? 0
    return {
  node: anchor.node,
      offset: Math.max(0, Math.min(point.offset, len))
    }
  }
  // Fallback: the leaf hasn't rendered yet — anchor in the block.
  const block = findBlockElement(root, point.path.slice(0, -1))
  if (block) return { node: block, offset: 0 }
  return null
}

/** Convert a DOM (Node, offset) tupleback to a model Point. */
export const toModelPoint = (
  root: HTMLElement,
  node: Node,
  offset: number
): Point | null => {
  // Case 1: caret is on a text node — walk up to the closest leaf and
  // figure out whether it's a zero-width filler or real string.
  if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
    const leafEl = node.parentElement.closest(
      "[data-leaf-path]"
    ) as HTMLElement | null
    if (leafEl) {
      const path = JSON.parse(
        leafEl.getAttribute("data-leaf-path") ?? "null"
      ) as Path | null
      if (path) {
        // If the parent (or any ancestor up to the leaf) is a zero-width
        // span, the leaf is empty in the model — clamp offset to 0.
        const isZeroWidth =
          !!node.parentElement.closest("[data-slate-zero-width]")
        if (isZeroWidth) {
          return { path, offset: 0 }
        }
        const len = node.textContent?.length ?? 0
        return { path, offset: Math.min(offset, len) }
      }
    }
  }

  // Case 2: caret on an element node.
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement

    // 2a: caret inside the leaf wrapper or one of its descendants but
    // not on a text node — resolve to the leaf's text anchor.
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
        // offset here is index among childNodes — best-effort map to
        // text length when offset > 0, else 0.
        return { path, offset: offset > 0 ? len : 0 }
      }
    }

    // 2b: caret on a void (mention) — translate to neighbouring text leaf.
    const voidAncestor = el.closest("[data-void-path]") as HTMLElement | null
    if (voidAncestor) {
      const path = JSON.parse(
        voidAncestor.getAttribute("data-void-path") ?? "null"
      ) as Path | null
      if (path) {
        return resolveAroundInline(root, path, offset > 0 ? "after" : "before")
      }
    }

    // 2c: caret on a block <div> between children.
    const blockAncestor = el.closest("[data-block-path]") as HTMLElement | null
    if (blockAncestor && el === blockAncestor) {
      const blockPath = JSON.parse(
        el.getAttribute("data-block-path") ?? "null"
      ) as Path | null
      if (blockPath) {
        const bi = blockPath[0] ?? 0
        const child = el.children[offset] as HTMLElement | undefined
        if (child) {
          // Either a text wrapper or a void.
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
        }
        // Past last child: anchor at end of last text leaf in block.
        if (offset >= el.children.length && el.children.length > 0) {
          const last = el.children[el.children.length - 1] as HTMLElement
          const innerLeaf = last.querySelector?.(
            "[data-leaf-path]"
          ) as HTMLElement | null
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
          const voidPath = last.getAttribute("data-void-path")
          if (voidPath) {
            return resolveAroundInline(
              root,
              JSON.parse(voidPath) as Path,
              "after"
            )
          }
        }
        return { path: [bi, 0], offset: 0 }
      }
    }
  }

  // Case 3: walk up looking for a leaf/void.
  let cur: HTMLElement | null =
    node.nodeType === Node.TEXT_NODE
      ? (node.parentElement ?? null)
      : (node as HTMLElement)
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
    (c) => c.getAttribute("data-void-path")=== targetAttr
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