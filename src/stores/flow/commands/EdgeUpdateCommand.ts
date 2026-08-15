import type { FlowCommand } from "../registry"
import { patchEdge } from "./helpers"

/** 改连线（label / animated / data 等）。自逆。 */
export const EdgeUpdateCommand: FlowCommand = {
  type: "edge.update",
  inverse: "edge.update",
  name: "修改连线",

  apply: patchEdge
}
