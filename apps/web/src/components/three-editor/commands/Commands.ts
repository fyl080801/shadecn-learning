import { AddObjectCommand } from "./AddObjectCommand"
import { AddScriptCommand } from "./AddScriptCommand"
import { MoveObjectCommand } from "./MoveObjectCommand"
import { MultiCmdsCommand } from "./MultiCmdsCommand"
import { RemoveObjectCommand } from "./RemoveObjectCommand"
import { RemoveScriptCommand } from "./RemoveScriptCommand"
import { SetCameraLookAtCommand } from "./SetCameraLookAtCommand"
import { SetCameraPoseCommand } from "./SetCameraPoseCommand"
import { SetColorCommand } from "./SetColorCommand"
import { SetCrowdSpacingCommand } from "./SetCrowdSpacingCommand"
import { SetEditorPropertyCommand } from "./SetEditorPropertyCommand"
import { SetGeometryCommand } from "./SetGeometryCommand"
import { SetGeometryValueCommand } from "./SetGeometryValueCommand"
import { SetMaterialColorCommand } from "./SetMaterialColorCommand"
import { SetMaterialCommand } from "./SetMaterialCommand"
import { SetMaterialMapCommand } from "./SetMaterialMapCommand"
import { SetMaterialRangeCommand } from "./SetMaterialRangeCommand"
import { SetMaterialValueCommand } from "./SetMaterialValueCommand"
import { SetMaterialVectorCommand } from "./SetMaterialVectorCommand"
import { SetPositionCommand } from "./SetPositionCommand"
import { SetRotationCommand } from "./SetRotationCommand"
import { SetScaleCommand } from "./SetScaleCommand"
import { SetSceneCommand } from "./SetSceneCommand"
import { SetScriptValueCommand } from "./SetScriptValueCommand"
import { SetShadowValueCommand } from "./SetShadowValueCommand"
import { SetTextureParametersCommand } from "./SetTextureParametersCommand"
import { SetUuidCommand } from "./SetUuidCommand"
import { SetValueCommand } from "./SetValueCommand"
import { registerCommandClasses } from "./registry"

// 登记全部命令，供 History / 组合命令按 `type` 反序列化（见 registry.ts）。
// 加新命令时这里和下面的导出各加一行。
registerCommandClasses({
  AddObjectCommand,
  AddScriptCommand,
  MoveObjectCommand,
  MultiCmdsCommand,
  RemoveObjectCommand,
  RemoveScriptCommand,
  SetCameraLookAtCommand,
  SetCameraPoseCommand,
  SetColorCommand,
  SetCrowdSpacingCommand,
  SetEditorPropertyCommand,
  SetGeometryCommand,
  SetGeometryValueCommand,
  SetMaterialColorCommand,
  SetMaterialCommand,
  SetMaterialMapCommand,
  SetMaterialRangeCommand,
  SetMaterialValueCommand,
  SetMaterialVectorCommand,
  SetPositionCommand,
  SetRotationCommand,
  SetScaleCommand,
  SetSceneCommand,
  SetScriptValueCommand,
  SetShadowValueCommand,
  SetTextureParametersCommand,
  SetUuidCommand,
  SetValueCommand
})

export {
  AddObjectCommand,
  AddScriptCommand,
  MoveObjectCommand,
  MultiCmdsCommand,
  RemoveObjectCommand,
  RemoveScriptCommand,
  SetCameraLookAtCommand,
  SetCameraPoseCommand,
  SetColorCommand,
  SetCrowdSpacingCommand,
  SetEditorPropertyCommand,
  SetGeometryCommand,
  SetGeometryValueCommand,
  SetMaterialColorCommand,
  SetMaterialCommand,
  SetMaterialMapCommand,
  SetMaterialRangeCommand,
  SetMaterialValueCommand,
  SetMaterialVectorCommand,
  SetPositionCommand,
  SetRotationCommand,
  SetScaleCommand,
  SetSceneCommand,
  SetScriptValueCommand,
  SetShadowValueCommand,
  SetTextureParametersCommand,
  SetUuidCommand,
  SetValueCommand
}
