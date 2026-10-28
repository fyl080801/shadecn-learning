import { createApp, h, reactive, type Component } from "vue"

/**
 * 将 Vue 对话框组件挂载到一个追加到 document.body 的独立 DOM 节点中，
 * 使命令式调用处（如 Loader.ts）可以像等待旧的 vanilla-DOM 对话框一样
 * `await` 一个 shadcn Dialog。
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
 * 挂载一个没有可等待返回值的对话框——它只是自行打开和关闭
 * （Esc 键、遮罩点击，或其自带的取消/渲染/……按钮）。
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
