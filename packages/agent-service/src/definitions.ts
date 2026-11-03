import { createAgentRegistry, DEFAULT_AGENT_MODEL, loadAgentConfigs, type AgentRegistry } from '@learning/agent-core/agents'
import { BUILTIN_SKILLS } from '@learning/agent-core/skills'
import { createTextSkillRegistry, loadTextSkills, type TextSkillRegistry } from '@learning/agent-core/text-skills'
import type { AgentModels } from './models.js'
import type { AgentOptions } from './options.js'

export const AGENT_DEFINITIONS = Symbol('AGENT_DEFINITIONS')
export const AGENT_TEXT_SKILLS = Symbol('AGENT_TEXT_SKILLS')

/**
 * agent 定义（docs/26 §3.1）和文字技能（§3.8）：启动时读并校验，**不管 agent 启没启用**（定义坏了是打包的错，不该等到有人配上模型才发现）。
 * 校验放工厂里：Nest 建全部 provider 才算启动成功，抛错就不监听端口。`model` 只按 key 在不在模型表判，那一项此刻用不用得了到用时才报。
 */
export function loadAgentDefinitions(options: AgentOptions, models: AgentModels): AgentRegistry {
  try {
    return createAgentRegistry(loadAgentConfigs(options.definitionsDir), { skills: BUILTIN_SKILLS, models: [DEFAULT_AGENT_MODEL, ...Object.keys(models)] })
  } catch (err) {
    console.error(`[agent] agent 定义不合法，服务不启动：${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

/** 目录不存在 = 没有文字技能；根上的 `README.md` 是目录说明、不算技能 */
export function loadAgentTextSkills(options: AgentOptions): TextSkillRegistry {
  try {
    return createTextSkillRegistry(loadTextSkills(options.textSkillsDir), { skills: BUILTIN_SKILLS })
  } catch (err) {
    console.error(`[agent] 文字技能不合法，服务不启动：${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}
