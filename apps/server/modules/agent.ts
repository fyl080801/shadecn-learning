import { createAgentModule } from '@shadecn/mod-agent'
import type { ServerApp } from '../app.ts'
import {
  agentConfig,
  agentDefinitionsDir,
  agentModelsFile,
  agentProviderApiKey,
  agentTextSkillsDir,
  agentWorkspaceDir,
  host,
  instanceId,
  isDev,
  s3Config,
  s3Enabled,
} from '../config.ts'
import { isBundle, moduleDir } from '../runtime.ts'
import { agentConversations, agentGrants, agentRunLog } from '../store/agent.ts'
import { flows } from '../store/flows.ts'
import { projects } from '../store/projects.ts'
import { users } from '../store/users.ts'

/**
 * 画布 agent 模块的装配点：能力在 `@shadecn/mod-agent`（编排引擎在 `@shadecn/agent`），这里只把底座的东西交进去 ——
 * 解析好的配置、各路径、会话 / 运行日志 / Grant 的落库、用户简况、成员关系判定。
 *
 * **import 这个文件就装配好了端口**，并且当场校验 agent 定义、文字技能、模型表（不合法就抛，进程不监听端口）。
 * 测试的 setup 也 import 它。
 */
export const agentModule = createAgentModule<ServerApp>({
  config: agentConfig,
  instanceId,
  host,
  isDev,
  paths: {
    workspaceDir: agentWorkspaceDir,
    modelsFile: agentModelsFile,
    definitionsDir: agentDefinitionsDir,
    textSkillsDir: agentTextSkillsDir,
  },
  providerApiKey: agentProviderApiKey,
  storage: { enabled: s3Enabled, keyPrefix: s3Config.keyPrefix },
  runner: { isBundle, moduleDir },
  stores: {
    conversations: agentConversations,
    runLog: agentRunLog,
    userProfiles: users.briefs,
    grants: agentGrants,
    // 和 `requireFlowMember` 同口径：画布（及其项目）没被删，且这个人是项目成员（个人空间即所有者）
    async flowAccess(flowId, userId) {
      const target = await flows.locate(flowId)
      if (!target) return null
      return (await projects.membershipOf(target.projectId, userId)) ? target : null
    },
  },
})
