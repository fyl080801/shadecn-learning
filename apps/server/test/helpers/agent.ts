import { vi } from 'vitest'
import { createAgentRuntime, type AgentRuntime, type AgentRuntimeOptions } from '@shadecn/agent/session'
import { gatewayFetch, registerScriptedModel, type ScriptedModel, type ScriptedStep } from '@shadecn/agent/testing'
import { agentHostOptions, replaceAgentRuntime } from '../../agent/index.ts'
import { app } from '../../app.ts'

/**
 * 用脚本化的模型换掉 agent runtime，走完整的二期路径：进程内驱动跑 runner → 本服务的网关路由
 * （`/api/agent-gateway/*`，经整个 app 的中间件栈，和生产同一个挂载点）→ 模型代理 → 脚本化的 OpenAI 兼容上游。
 * 宿主接线是生产那套（`agentHostOptions`）：真库、真 Grant、真 direct connection。
 *
 * runner 打网关、它里面的 OpenAI SDK 打模型代理用的都是全局 fetch：这里把发往测试网关的请求交给 `app.fetch`，
 * 其余的照样拒绝（测试仍然是密闭的）。`setup.ts` 的 afterEach 会把 fetch 还原。
 */
export function useScripted(
  responses: ScriptedStep[],
  overrides: Partial<AgentRuntimeOptions> = {},
  model: { imageInput?: boolean } = {},
): AgentRuntime & { scripted: ScriptedModel } {
  const scripted = registerScriptedModel(model)
  scripted.setResponses(responses)
  const runtime = createAgentRuntime({ ...scripted.runtimeOptions(), ...agentHostOptions, ...overrides })
  replaceAgentRuntime(runtime)
  vi.stubGlobal('fetch', gatewayFetch((request) => app.fetch(request)))
  return Object.assign(runtime, { scripted })
}
