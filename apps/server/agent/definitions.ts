import { createAgentRegistry, DEFAULT_AGENT_MODEL, loadAgentConfigs, type AgentRegistry } from '@shadecn/agent/agents'
import { BUILTIN_SKILLS } from '@shadecn/agent/skills'
import { agentDefinitionsDir } from '../config.ts'

/**
 * agent 定义（docs/26 §3.1）：启动时读 {@link agentDefinitionsDir} 里的 `*.md` 并校验 —— 模块一被 import 就读（index.ts 经 `agent/index.ts`
 * 在 listen 之前 import 到它），**不管 agent 启没启用**（没配模型也校验：定义坏了是打包的错，不该等到有人配上模型才发现）。
 * 不合法（名字、重名、`tools` 里不认识的工具、`model` 不在模型表、没有 `canvas`）就打一行 `[agent]` 错误、抛出，服务起不来。
 *
 * 模型表 P2 只有 `default`（`AGENT_PROVIDER` / `AGENT_MODEL` / … 那一项，docs/26 §3.4）；技能注册表是内置的那份，和 runtime 用的同一个。
 */
function loadAgentDefinitions(): AgentRegistry {
  try {
    return createAgentRegistry(loadAgentConfigs(agentDefinitionsDir), { skills: BUILTIN_SKILLS, models: [DEFAULT_AGENT_MODEL] })
  } catch (err) {
    console.error(`[agent] agent 定义不合法，服务不启动：${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

export const agentDefinitions: AgentRegistry = loadAgentDefinitions()
