import type { FlowCommand } from "../registry"
import { registerFlowCommands } from "../registry"

import { EdgeAddCommand } from "./EdgeAddCommand"
import { EdgeRemoveCommand } from "./EdgeRemoveCommand"
import { EdgeUpdateCommand } from "./EdgeUpdateCommand"
import { GraphMetaCommand } from "./GraphMetaCommand"
import { NodeAddCommand } from "./NodeAddCommand"
import { NodeMoveCommand } from "./NodeMoveCommand"
import { NodeRemoveCommand } from "./NodeRemoveCommand"
import { NodeResizeCommand } from "./NodeResizeCommand"
import { NodeUpdateCommand } from "./NodeUpdateCommand"

/**
 * 内置命令清单 —— **加新命令改这一处就够了**：
 * 新写一个 XxxCommand.ts，import 进来，往下面数组里加一行。
 *
 * 注册在这里显式做掉，而不是让每个命令文件自己带副作用：
 * 副作用式注册一旦被 tree-shaking 掉或者 import 顺序变了，
 * 出来的症状是「某种操作静默不生效」，很难查。
 */
export const FLOW_COMMANDS: readonly FlowCommand[] = [
  NodeAddCommand,
  NodeRemoveCommand,
  NodeMoveCommand,
  NodeResizeCommand,
  NodeUpdateCommand,
  EdgeAddCommand,
  EdgeRemoveCommand,
  EdgeUpdateCommand,
  GraphMetaCommand
]

registerFlowCommands(FLOW_COMMANDS)

export {
  EdgeAddCommand,
  EdgeRemoveCommand,
  EdgeUpdateCommand,
  GraphMetaCommand,
  NodeAddCommand,
  NodeMoveCommand,
  NodeRemoveCommand,
  NodeResizeCommand,
  NodeUpdateCommand
}
export { clone, patchEdge, patchNode } from "./helpers"
