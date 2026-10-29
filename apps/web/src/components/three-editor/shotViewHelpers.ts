// 机位视角下的辅助器渲染约定。
//
// 机位视角 = 成片预览（画幅闸门让取景框内画面等于真实成片，见 directorAspectGate），
// 因此 Viewport 的 performRender 只在导演视角渲染 editor.sceneHelpers 整组——相机
// 视锥、灯光辅助器这类纯编辑器元素不该进入镜头。
//
// 但「编辑必需」的叠加层是例外：没有它们就无法在机位视角里编辑。变换 gizmo 早已是
// 例外（否则机位视角选中对象后拖不动）；姿势编辑的骨架线 / 关节手柄 / 关节旋转 gizmo
// 同理——useCharacterJointControls 的拾取与 gizmo 都用 editor.viewportCamera，机位
// 视角下点得到也拖得动，唯独整组不渲染使其完全不可见，等于姿势编辑在机位视角不可用。
//
// 例外由创建方给对象打 userData 标记、渲染侧只认标记：Viewport 属引擎层，不能反向
// 依赖 director 域去按类型枚举「哪些辅助器算编辑必需」。
//
// 注意成片/截图链路不受影响：影片录制整组隐藏 sceneHelpers（useDirectorMovieExport
// 的 prepareScene），关键帧截取与机位缩略图只渲染 scene + backdrop（useViewportCapture /
// useCameraThumbnail），三者都不经过本模块。
export const SHOT_VIEW_HELPER_KEY = "shotViewHelper"

/** 标记一个 sceneHelpers 子节点为「机位视角下也渲染」。 */
export function markShotViewHelper<T extends { userData: Record<string, any> }>(
  object: T
): T {
  object.userData[SHOT_VIEW_HELPER_KEY] = true
  return object
}

export function isShotViewHelper(object: any): boolean {
  return object?.userData?.[SHOT_VIEW_HELPER_KEY] === true
}

/**
 * 机位视角下渲染 sceneHelpers，但只显示标记过的子节点：逐帧临时隐藏其余可见子节点，
 * 渲染后原样恢复，不留下任何持久的可见性改动（骨架线的显隐由姿势分节自身的挂载/卸载维护，见
 * DirectorCharacterPosePanel.vue，本函数不能污染它）。
 *
 * 整组 `visible === false` 时（录制期间）一切都不渲染，与导演视角分支的守卫一致。
 */
export function renderShotViewHelpers(
  renderer: any,
  sceneHelpers: any,
  camera: any
): void {
  if (sceneHelpers?.visible !== true) return

  const hidden: any[] = []
  for (const child of sceneHelpers.children as any[]) {
    if (child.visible !== true || isShotViewHelper(child)) continue
    child.visible = false
    hidden.push(child)
  }

  renderer.render(sceneHelpers, camera)

  for (const child of hidden) child.visible = true
}
