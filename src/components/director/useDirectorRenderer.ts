// @ts-nocheck
import * as THREE from "three"

// EditorViewport only wires up rendering once it receives the editor's
// `rendererCreated` signal — normally dispatched by SidebarProject's own
// onMounted hook. The director console doesn't mount SidebarProject, so
// without this the renderer (and therefore `pmremGenerator`) never gets
// created, and the very first `sceneEnvironmentChanged` dispatch (e.g. from
// autosave restoring a saved scene) crashes on a null pmremGenerator.
export function useDirectorRenderer(editor: any) {
  function createRenderer() {
    const config = editor.config

    const renderer = new THREE.WebGLRenderer({
      antialias: config.getKey("project/renderer/antialias")
    })

    renderer.shadowMap.enabled = config.getKey("project/renderer/shadows")
    renderer.shadowMap.type = parseFloat(
      config.getKey("project/renderer/shadowType")
    )
    renderer.toneMapping = parseFloat(
      config.getKey("project/renderer/toneMapping")
    )
    renderer.toneMappingExposure = config.getKey(
      "project/renderer/toneMappingExposure"
    )

    editor.signals.rendererCreated.dispatch(renderer)
    editor.signals.rendererUpdated.dispatch()
  }

  // Deferred to a microtask so this always runs after EditorViewport's own
  // mount, which registers the `rendererCreated` listener that sets up
  // pmremGenerator (same rationale as SidebarProject.vue's identical
  // deferral).
  queueMicrotask(createRenderer)
}
