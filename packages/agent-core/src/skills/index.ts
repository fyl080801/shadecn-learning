import { canvasSkill } from './canvas/index.js'
import { agentsSkill } from './agents/index.js'
import { directorSkill } from './director/index.js'
import { mediaExecSkill, mediaViewSkill } from './media/index.js'
import { createSkillRegistry } from './registry.js'

export * from './registry.js'
export { canvasSkill } from './canvas/index.js'
export {
  AGENTS_SKILL_ID,
  agentsSkill,
  createRequestConfirmationTool,
  createRunAgentTool,
  REQUEST_CONFIRMATION_ALONE_REASON,
  type RunAgentArgs,
} from './agents/index.js'
export { mediaExecSkill, mediaViewSkill } from './media/index.js'
export { createDirectorTools, DIRECTOR_READ_TOOL_NAMES, DIRECTOR_WRITE_TOOL_NAMES, directorSkill } from './director/index.js'

/**
 * 平台随代码提供的全部内置技能（docs/23 §4）。顺序 = 系统提示里的顺序（已加载段、技能目录）。
 * 新增技能：在 `skills/<名字>/` 里 `defineSkill`，再加进这里 —— runner 和服务端都从这一份构造工具。
 */
export const BUILTIN_SKILLS = createSkillRegistry([canvasSkill, mediaViewSkill, mediaExecSkill, directorSkill, agentsSkill])
