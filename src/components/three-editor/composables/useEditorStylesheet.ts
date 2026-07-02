import { onBeforeUnmount, onMounted } from "vue"

const CSS_HREF = "/three-editor/css/main.css"

export function useEditorStylesheet() {
  let cssLink: HTMLLinkElement | null = null

  onMounted(() => {
    cssLink = document.createElement("link")
    cssLink.rel = "stylesheet"
    cssLink.href = CSS_HREF
    document.head.appendChild(cssLink)
  })

  onBeforeUnmount(() => {
    cssLink?.remove()
  })
}
