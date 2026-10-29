import { Command } from "../Command"
import type { Editor } from "../Editor"
import { getObjectCenter } from "@/components/director/directorObjectCenter"

// 群众分组的"缩放"语义是调整成员之间的水平间距（成员 position 的 x/z 按比例
// 整体缩放），而非缩放分组或每个成员自身的可见大小——分组 object.scale 恒定
// 保持 (1,1,1)，因此不能复用 SetScaleCommand。
//
// x/z 两个方向的间距倍数彼此独立（CrowdSpacingFactors），而非合并为单一倍率：
// 拖拽手柄或属性面板都可能只调整其中一个轴，若强行折算为一个数会导致调
// 任一轴都联动改变另一轴（见 directorCrowdGroup.ts 的 CrowdGroupConfig 注释）。
//
// 命令按"变更前后所有子对象的 x/z 位置"做快照，undo/redo 直接回放而非按栅格
// 公式重算——这样即使成员此前被单独拖动过（相对分组的个性化位置调整），缩放
// 操作也只是把现状整体等比放大/缩小，不会抹掉这些个性化偏移。
//
// updatable = true：连续拖动间距滑块时，History 的 500ms 合并窗口会将其
// 归并为一条历史（见 SetPositionCommand/SetPoseValuesCommand 同类约定）。
//
// optionalOldFactors/optionalOldPositions（仿照 SetPositionCommand 的
// optionalOldPosition）：属性面板的间距滑块在构造命令的瞬间，子对象仍处于
// 变更前的状态，可以直接从 object 读取基准；但 Viewport.ts 的缩放手柄拖拽
// 在拖拽过程中已经直接改写子对象位置做实时预览（TransformControls 的既有
// 拖拽即预览、mouseUp 才提交历史的模式），到 mouseUp 构造这条命令时子对象
// 已经是"新"位置，无法再从 object 反推"旧"基准——因此该场景必须由调用方
// 显式传入 mouseDown 时刻快照的基准值。
export interface CrowdSpacingFactors {
  x: number
  z: number
}

class SetCrowdSpacingCommand extends Command {
  object: any
  oldFactors: CrowdSpacingFactors
  newFactors: CrowdSpacingFactors
  oldPositions: { x: number; z: number }[]
  newPositions: { x: number; z: number }[]

  constructor(
    editor: Editor,
    object: any = null,
    newFactors: CrowdSpacingFactors | null = null,
    optionalOldFactors: CrowdSpacingFactors | null = null,
    optionalOldPositions: { x: number; z: number }[] | null = null
  ) {
    super(editor)

    this.type = "SetCrowdSpacingCommand"
    this.name = "调整分组间距"
    this.updatable = true

    this.object = object
    this.oldFactors = optionalOldFactors ?? {
      x: object?.userData?.crowdConfig?.scaleFactorX ?? 1,
      z: object?.userData?.crowdConfig?.scaleFactorZ ?? 1
    }
    this.newFactors = newFactors ?? this.oldFactors

    this.oldPositions =
      optionalOldPositions ??
      (object
        ? object.children.map((child: any) => ({
            x: child.position.x,
            z: child.position.z
          }))
        : [])
    this.newPositions = this.computePositions(this.newFactors)
  }

  private computePositions(
    factors: CrowdSpacingFactors
  ): { x: number; z: number }[] {
    const ratioX = this.oldFactors.x === 0 ? 1 : factors.x / this.oldFactors.x
    const ratioZ = this.oldFactors.z === 0 ? 1 : factors.z / this.oldFactors.z
    // 分组的中心位置（见 directorObjectCenter.ts）也烘焙在成员 position 上：成员此刻
    // 的坐标 = 栅格摆位 − center。间距缩放该缩的只有栅格摆位那一半，故先把 center 加
    // 回去、按比例缩放、再减掉。少了这一步，每调一次间距中心偏移就跟着放大/缩小一次。
    const center = this.object ? getObjectCenter(this.object) : { x: 0, z: 0 }
    return this.oldPositions.map((p) => ({
      x: (p.x + center.x) * ratioX - center.x,
      z: (p.z + center.z) * ratioZ - center.z
    }))
  }

  private applyPositions(list: { x: number; z: number }[]) {
    const children = this.object.children
    for (let i = 0; i < children.length; i++) {
      const p = list[i]
      if (!p) continue
      children[i].position.x = p.x
      children[i].position.z = p.z
    }
    this.object.updateMatrixWorld(true)
  }

  execute() {
    this.applyPositions(this.newPositions)
    this.object.userData.crowdConfig.scaleFactorX = this.newFactors.x
    this.object.userData.crowdConfig.scaleFactorZ = this.newFactors.z
    this.editor.signals.objectChanged.dispatch(this.object)
  }

  undo() {
    this.applyPositions(this.oldPositions)
    this.object.userData.crowdConfig.scaleFactorX = this.oldFactors.x
    this.object.userData.crowdConfig.scaleFactorZ = this.oldFactors.z
    this.editor.signals.objectChanged.dispatch(this.object)
  }

  update(command: SetCrowdSpacingCommand) {
    this.newFactors = command.newFactors
    this.newPositions = this.computePositions(this.newFactors)
  }

  toJSON() {
    const output = super.toJSON()

    output.objectUuid = this.object.uuid
    output.oldFactors = this.oldFactors
    output.newFactors = this.newFactors
    output.oldPositions = this.oldPositions
    output.newPositions = this.newPositions

    return output
  }

  fromJSON(json: any) {
    super.fromJSON(json)

    this.object = this.editor.objectByUuid(json.objectUuid)
    this.oldFactors = json.oldFactors
    this.newFactors = json.newFactors
    this.oldPositions = json.oldPositions
    this.newPositions = json.newPositions
  }
}

export { SetCrowdSpacingCommand }
