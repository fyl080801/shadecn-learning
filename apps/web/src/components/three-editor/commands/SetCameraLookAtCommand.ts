import { Command } from "../Command"
import type { Editor } from "../Editor"
import { readAuthored, writeAuthored } from "../EvaluatedTransform"
import {
  applyCameraFollow,
  applyCameraLookAt,
  cloneCameraLookAt,
  ensureCameraLookAt,
  type CameraLookAtState
} from "@/components/director/cameraLookAt"

// 摄像机"注视目标"（camera.userData.lookAt，见 director/cameraLookAt.ts）的
// 历史命令。对准本身是注视状态的派生量（经求值层落地、不进历史），因此这里记录的是
// 状态快照，execute/undo 写回状态后经 applyCameraLookAt 重新对准——位置模式对准缓存
// 坐标，跟随模式实时解析目标网格中心，朝向随状态一并复原。oldValue 取
// ensureCameraLookAt 的结果：摄像机尚无注视状态时它以当前视线上的推导点建立手动状态，
// 撤销回放该点不改变朝向，与"未提交前摄像机行为保持不变"的面板约定一致。
//
// **换模式时连 authored 朝向一起记**（可选的 rotation 快照）：aim 模式下 authored 只剩
// 倾斜、手动模式下它是完整朝向，两者含义不同，切换时必须换算一次才不跳变（换算收在
// planCameraLookAtSwitch）。不带 rotation 的调用（拖注视点、时间轴写回）保持原样不碰朝向
// ——那些编辑不改变 authored 的含义。
//
// updatable = true：连续修改同一摄像机的注视（坐标步进、快速切换目标）在
// History 的 500ms 窗口内合并为一条。

class SetCameraLookAtCommand extends Command {
  object: any
  oldState: CameraLookAtState
  newState: CameraLookAtState
  /** authored 朝向快照（xyzw）；null = 本次编辑不碰朝向。 */
  oldRotation: number[] | null
  newRotation: number[] | null

  constructor(
    editor: Editor,
    camera: any = null,
    newState: CameraLookAtState | null = null,
    optionalOldState: CameraLookAtState | null = null,
    newRotation: number[] | null = null
  ) {
    super(editor)

    this.type = "SetCameraLookAtCommand"
    this.name = "设置注视目标"
    this.updatable = true

    this.object = camera

    this.oldState =
      optionalOldState !== null
        ? cloneCameraLookAt(optionalOldState)
        : camera !== null
          ? cloneCameraLookAt(ensureCameraLookAt(camera))
          : { mode: "free", targetUuid: null, target: { x: 0, y: 0, z: 0 } }

    this.newState =
      newState !== null ? cloneCameraLookAt(newState) : this.oldState

    this.newRotation = newRotation ? [...newRotation] : null
    // old 侧只在真要改朝向时才抄：构造发生在应用之前，此刻读到的正是撤销要回到的那一份。
    this.oldRotation =
      newRotation && camera !== null
        ? [...readAuthored(camera, "quaternion")]
        : null
  }

  // 写入克隆：跟随模式下 applyCameraLookAt 会把解析出的目标中心回写到
  // userData.lookAt.target（缓存），不能让它污染命令持有的快照。
  private apply(state: CameraLookAtState, rotation: number[] | null) {
    this.object.userData.lookAt = cloneCameraLookAt(state)
    // 先写 authored 再对准：对准是叠在它之上的分量，顺序反了中间会闪一帧旧朝向。
    if (rotation) writeAuthored(this.object, "quaternion", rotation)
    // 顺序固定为「跟拍定站位 → 对准」（同 applyTimelineAt 末尾与 useCameraLookAt）：本命令
    // 写的是**整份**注视状态，而跟拍的三个读数（X角度/Y角度/距离）就在里面——站位是它们的
    // 派生量，不在这里重算的话，紧接着的对准是拿**上一帧的站位**算出来的，而站位要等
    // objectChanged 传到 useCameraLookAt 才补上。表现是改一下角度镜头先原地转一下、下一个
    // 信号才挪过去（撤销那一路同理）。
    applyCameraFollow(this.editor, this.object)
    applyCameraLookAt(this.editor, this.object)
    this.editor.signals.objectChanged.dispatch(this.object)
  }

  execute() {
    this.apply(this.newState, this.newRotation)
  }

  undo() {
    this.apply(this.oldState, this.oldRotation)
  }

  update(command: SetCameraLookAtCommand) {
    this.newState = cloneCameraLookAt(command.newState)
    // 后一条不碰朝向时保留前一条换算出来的那一份：合并后的这条命令要一次性从
    // oldRotation 走到最终状态，把它清成 null 的话撤销就漏了朝向那一半。
    if (!command.newRotation) return
    this.newRotation = [...command.newRotation]
    // **old 侧同样要补**：合并串里第一条若不碰朝向（拖注视点、改角度步进器），这条命令的
    // oldRotation 一直是 null，而 execute 已经把换算后的朝向写下去了——undo 走
    // `apply(oldState, null)` 整个跳过 writeAuthored，撤销之后机位的 authored 朝向停在
    // 新含义上、userData.lookAt 却回到了旧模式，两者按不同约定解释同一份数据。
    // 取后一条构造时抄下的那一份：它抄在「改朝向那一步之前」，正是撤销要回到的值
    // （前面那些不碰朝向的编辑不改变 authored）。
    this.oldRotation ??= command.oldRotation ? [...command.oldRotation] : null
  }

  toJSON() {
    const output = super.toJSON()

    output.objectUuid = this.object.uuid
    output.oldState = this.oldState
    output.newState = this.newState
    output.oldRotation = this.oldRotation
    output.newRotation = this.newRotation

    return output
  }

  fromJSON(json: any) {
    super.fromJSON(json)

    this.object = this.editor.objectByUuid(json.objectUuid)
    this.oldState = json.oldState
    this.newState = json.newState
    this.oldRotation = json.oldRotation ?? null
    this.newRotation = json.newRotation ?? null
  }
}

export { SetCameraLookAtCommand }
