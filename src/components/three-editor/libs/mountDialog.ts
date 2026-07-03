import { createApp, h, reactive, type Component } from "vue"

/**
 * Mounts a Vue dialog component into a detached DOM node appended to
 * document.body, so imperative call sites (e.g. Loader.ts) can `await`
 * a shadcn Dialog the same way they awaited the old vanilla-DOM dialogs.
 */
export function mountDialog(component: Component, initialProps: Record<string, any>) {
  const props = reactive(initialProps)
  const container = document.createElement("div")
  document.body.appendChild(container)

  const app = createApp({
    render: () => h(component, props)
  })

  app.mount(container)

  return {
    props,
    unmount() {
      app.unmount()
      container.remove()
    }
  }
}

/**
 * Mounts a dialog that has no result to await — it just opens and closes
 * itself (Escape, overlay click, or its own Cancel/Render/... button).
 */
export function mountClosableDialog(
  component: Component,
  initialProps: Record<string, any>
) {
  const { props, unmount } = mountDialog(component, {
    ...initialProps,
    open: true,
    "onUpdate:open": (value: boolean) => {
      props.open = value
      if (!value) unmount()
    }
  })

  return { unmount }
}
