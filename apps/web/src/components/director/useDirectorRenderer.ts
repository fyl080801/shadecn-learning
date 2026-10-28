import * as THREE from "three"

// EditorViewport 仅在收到编辑器的 `rendererCreated` 信号后才接入渲染——
// 该信号通常由 SidebarProject 自身的 onMounted 钩子分发。导演控制台不挂载
// SidebarProject，因此若不做此处理，渲染器（进而 `pmremGenerator`）永远不会被创建，
// 而第一次 `sceneEnvironmentChanged` 分发（例如自动保存恢复已保存的场景时）
// 就会因 pmremGenerator 为 null 而崩溃。
export function useDirectorRenderer(editor: any) {
  function createRenderer() {
    const config = editor.config

    const renderer = new THREE.WebGLRenderer({
      antialias: config.getKey("project/renderer/antialias")
    })

    renderer.shadowMap.enabled = config.getKey("project/renderer/shadows")
    renderer.shadowMap.type = parseFloat(
      config.getKey("project/renderer/shadowType")
    ) as THREE.ShadowMapType
    renderer.toneMapping = parseFloat(
      config.getKey("project/renderer/toneMapping")
    ) as THREE.ToneMapping
    renderer.toneMappingExposure = config.getKey(
      "project/renderer/toneMappingExposure"
    )

    editor.signals.rendererCreated.dispatch(renderer)
    editor.signals.rendererUpdated.dispatch()
  }

  // 延迟到微任务中执行，使此处始终在 EditorViewport 自身的挂载之后运行，
  // 后者注册了设置 pmremGenerator 的 `rendererCreated` 监听器
  // （理由与 SidebarProject.vue 中相同的延迟处理一致）。
  queueMicrotask(createRenderer)
}
