// Type augmentations for experimental Canvas 2D extensions
// (drawElementImage, paint event, layoutsubtree, devicePixelContentBoxSize).
// These APIs are not yet part of TS's lib.dom.d.ts.

interface CanvasRenderingContext2D {
  /**
   * Draws an element (and its layout subtree) onto the canvas.
   * Returns the transform matrix applied during drawing.
   * Experimental / Chromium-only.
   */
  drawElementImage(
    element: Element,
    x: number,
    y: number,
  ): DOMMatrix
}

interface HTMLCanvasElement {
  /**
   * Fired when the canvas's layout subtree needs repainting.
   * Only relevant when the `layoutsubtree` attribute is set.
   */
  addEventListener(
    type: "paint",
    listener: (this: HTMLCanvasElement, ev: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ): void
  removeEventListener(
    type: "paint",
    listener: (this: HTMLCanvasElement, ev: Event) => void,
    options?: boolean | EventListenerOptions,
  ): void
}

interface HTMLCanvasElement {
  /** Whether the canvas's child DOM is laid out as a paint source. */
  layoutsubtree?: boolean
}

interface ResizeObserverEntry {
  devicePixelContentBoxSize?: ReadonlyArray<ResizeObserverSize>
}

interface ResizeObserver {
  observe(
    target: Element,
    options?: { box?: "content-box" | "border-box" | "device-pixel-content-box" },
  ): void
}
