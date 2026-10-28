import { getEnvApiKey } from '@mariozechner/pi-ai'
import { resolveAgentModel } from '@shadecn/agent/model'
import { LocalSandboxProvider } from '@shadecn/agent/sandbox'
import { createAgentRuntime, type AgentRuntime } from '@shadecn/agent/session'
import { agentConfig, agentWorkspaceDir } from '../config.ts'
import { agentConversations, agentRunLog } from '../store/agent.ts'
import { users } from '../store/users.ts'

/**
 * 画布 Agent 在本服务里的装配点：环境变量 → `@shadecn/agent` 的显式参数。
 *
 * 那个包不读 `process.env`（见 `@shadecn/agent/model`），所以「没给 `AGENT_API_KEY` 时退回
 * pi 自己的环境变量约定」「沙箱子进程的 PATH」这类环境相关的决定都在这里做。
 *
 * **懒创建**：第一次有人访问 agent 接口时才解析模型。没配 key 的进程里它只是一个
 * `enabled: false` 的空壳，不影响启动、也不打一行警告以外的东西。
 */

let runtime: AgentRuntime | null = null

function buildRuntime(): AgentRuntime {
  const apiKey = agentConfig.apiKey || getEnvApiKey(agentConfig.provider) || ''
  const resolved = resolveAgentModel({
    provider: agentConfig.provider,
    model: agentConfig.model,
    baseUrl: agentConfig.baseUrl,
    api: agentConfig.api,
    apiKey,
  })
  if (!resolved.ok) {
    console.warn(`[agent] 未启用：${resolved.reason}`)
    return createAgentRuntime({
      model: null,
      disabledReason: resolved.reason,
      store: agentConversations,
      runLog: agentRunLog,
      displayName: users.displayName,
    })
  }

  const sandbox =
    agentConfig.sandbox === 'local'
      ? new LocalSandboxProvider({ rootDir: agentWorkspaceDir, pathEnv: process.env.PATH })
      : null
  console.info(
    `[agent] 已启用：${resolved.value.model.provider}/${resolved.value.model.id}` +
      `${sandbox ? '，本地沙箱（ffmpeg / ffprobe）已开启' : ''}`,
  )
  return createAgentRuntime({
    model: resolved.value,
    sandbox,
    store: agentConversations,
    runLog: agentRunLog,
    displayName: users.displayName,
  })
}

export function agentRuntime(): AgentRuntime {
  runtime ??= buildRuntime()
  return runtime
}

/** 测试用：换成一个用假模型驱动的 runtime；传 null 回到按环境变量构造 */
export function replaceAgentRuntime(next: AgentRuntime | null): void {
  runtime = next
}

/**
 * 进程退出前：中止所有在跑的轮次，并等它们收尾 —— 对话落库、运行日志写完、画布连接关掉。
 * 已经写进画布的改动保留，房间照常落库。**要在关数据库之前 await**（index.ts 的 shutdown 给了上限）。
 */
export function abortAgentRuns(reason: string): Promise<void> {
  return runtime?.abortAll(reason) ?? Promise.resolve()
}
