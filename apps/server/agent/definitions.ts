import { createAgentRegistry, loadAgentConfigs, type AgentRegistry } from '@shadecn/agent/agents'
import { BUILTIN_SKILLS } from '@shadecn/agent/skills'
import { createTextSkillRegistry, loadTextSkills, type TextSkillRegistry } from '@shadecn/agent/text-skills'
import { agentDefinitionsDir, agentTextSkillsDir } from '../config.ts'
import { agentModelKeys } from './models.ts'

/**
 * agent 定义（docs/26 §3.1）：启动时读 {@link agentDefinitionsDir} 里的 `*.md` 并校验 —— 模块一被 import 就读（index.ts 经 `agent/index.ts`
 * 在 listen 之前 import 到它），**不管 agent 启没启用**（没配模型也校验：定义坏了是打包的错，不该等到有人配上模型才发现）。
 * 不合法（名字、重名、`tools` 里不认识的工具、`model` 不在模型表、没有 `canvas`）就打一行 `[agent]` 错误、抛出，服务起不来。
 *
 * 模型表（docs/26 §3.4）= `default`（`AGENT_PROVIDER` / `AGENT_MODEL` / …）+ 模型表文件里的项（`models.ts`，同样在 import 时读、坏了起不来）：
 * `model` 只按 **key 在不在** 判 —— 那一项此刻用不用得了（环境变量没设、注册表里没有）不是启动错误，到用时才报。
 * 技能注册表是内置的那份，和 runtime 用的同一个。
 */
function loadAgentDefinitions(): AgentRegistry {
  try {
    return createAgentRegistry(loadAgentConfigs(agentDefinitionsDir), { skills: BUILTIN_SKILLS, models: agentModelKeys })
  } catch (err) {
    console.error(`[agent] agent 定义不合法，服务不启动：${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

export const agentDefinitions: AgentRegistry = loadAgentDefinitions()

/**
 * 文字技能（docs/26 §3.8，pi `SKILL.md`）：同 agent 定义，模块一被 import 就读 {@link agentTextSkillsDir} 并校验，启用与否都一样。
 * 目录不存在 = 没有文字技能；根上的 `README.md` 是目录说明、不算技能（发现规则见 `text-skills.ts`）。
 * 不合法（字段、正文为空、名字撞内置技能或它们的旧 id、`requires` 不是内置技能、`disable-model-invocation`）就打一行 `[agent]` 错误、抛出，服务起不来
 */
function loadAgentTextSkills(): TextSkillRegistry {
  try {
    return createTextSkillRegistry(loadTextSkills(agentTextSkillsDir), { skills: BUILTIN_SKILLS })
  } catch (err) {
    console.error(`[agent] 文字技能不合法，服务不启动：${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

export const agentTextSkills: TextSkillRegistry = loadAgentTextSkills()
