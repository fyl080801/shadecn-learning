import { onBeforeUnmount } from "vue"

// 机位原点以 camera.glb 子网格呈现（见 DirectorToolbar.vue 的 addCameraPosition）。
// 当某个机位被切为视口相机（机位视角）时，其自身的模型会处于镜头正前方并遮挡画面，
// 因此在该机位作为视口相机期间隐藏它的模型，切回导演视角或切换到其他机位时恢复显示。
//
// 与 useCharacterUnlitMaterial 同理：sceneGraphChanged 覆盖场景恢复（自动保存还原）
// 路径——模型随相机一起被 ObjectLoader 还原，但其 visible 状态不会自动同步到当前
// 视口相机，故在此做一次幂等扫描。
//
// 信号监听必须在 Viewport 注册自身 viewportCameraChanged/sceneGraphChanged 监听
// （后者会触发 render()）之前完成：否则 update() 改写 visible 后没有再次 render，
// 切回导演视角时机位模型仍停留在隐藏态，直到下一次 render（例如选中对象）才显现。
// 本组合件在 3DScene 的 setup 阶段被调用，早于子组件 EditorViewport 挂载，故在此同步
// 注册即可保证监听顺序在 Viewport 之前。
export function useCameraModelVisibility(editor: any) {
  function update() {
    const viewportCamera = editor.viewportCamera

    editor.scene.traverse((child: any) => {
      if (child.userData?.isCameraModel) {
        child.visible = child.parent !== viewportCamera
      }
    })
  }

  function onViewportCameraChanged() {
    update()
  }

  function onSceneGraphChanged() {
    update()
  }

  editor.signals.viewportCameraChanged.add(onViewportCameraChanged)
  editor.signals.sceneGraphChanged.add(onSceneGraphChanged)
  update()

  onBeforeUnmount(() => {
    editor.signals.viewportCameraChanged.remove(onViewportCameraChanged)
    editor.signals.sceneGraphChanged.remove(onSceneGraphChanged)
  })
}
