import { agentModelKey, DEFAULT_AGENT_MODEL } from '@learning/agent-core/agents'
import { createAgentRuntime, type AgentRuntime, type AgentRuntimeOptions } from '@learning/agent-core/session'
import { resolveProviderModel } from '@learning/llm/llm-providers'
import { AGENT_THINKING_LEVELS, isAgentThinkingLevel, type AgentThinkingLevel } from '@learning/llm/model'
import type { MediaReader } from '@learning/agent-core/media'
import type { AgentModels } from './models.js'
import type { AgentOptions } from './options.js'
import { agentGatewayUrl, type BuiltDriver } from './sandbox.js'

/**
 * 宿主接给编排层的东西：落库、用户信息、任务列表广播、执行身份、占用登记、共享登记、启动时校验过的定义和文字技能。
 * 启用与否都一样；测试换成脚本化模型时也展开它，测的就是生产那套接线。
 *
 * **`titleModel` 不进这里**，只在 {@link buildAgentRuntime}：脚本化上游按到达顺序出步，并行多一次标题请求会抢走每个现有用例的一步（`.claude/rules/agent.md`）。
 */
export const AGENT_HOST_OPTIONS = Symbol('AGENT_HOST_OPTIONS')
export type AgentHostOptions = Pick<AgentRuntimeOptions, 'store' | 'runLog' | 'userProfiles' | 'onRunsChange' | 'authorities' | 'leases' | 'runRegistry' | 'agents' | 'textSkills'>

/** 没启用时也要给的驱动：永远起不来（start 根本不会被调到） */
const NO_DRIVER: AgentRuntimeOptions['driver'] = {
  name: 'none',
  start: () => Promise.reject(new Error('agent 未启用')),
  reap: async () => {},
}

function thinkingOf(options: AgentOptions): AgentThinkingLevel | undefined {
  const { thinking } = options
  if (thinking === undefined) return undefined
  if (isAgentThinkingLevel(thinking)) return thinking
  // 写错了不让 agent 整个关掉（思考是锦上添花）：警告，当没配
  console.warn(`[agent] agent.thinking=${thinking} 不认识（只认 ${AGENT_THINKING_LEVELS.join(' / ')}），当作没配`)
  return undefined
}

/**
 * `AGENT_RUNTIME` 的工厂：配置 → agent-core 的显式参数。模型或驱动不可用就是一个 `enabled: false` 的 runtime，不影响启动。
 * 真实的 LLM key 只交给网关（模型请求由服务端发，docs/22 §4.3）；沙箱的环境变量只有网关地址、一次性 bootstrap token、工作目录和 `PATH`。
 */
export function buildAgentRuntime(options: AgentOptions, built: BuiltDriver, models: AgentModels, host: AgentHostOptions, mediaReader: MediaReader | undefined): AgentRuntime {
  const keys = [DEFAULT_AGENT_MODEL, ...Object.keys(models)]
  // 写了表里没有的键启动即失败，不管这次启没启用
  if (options.titleModel !== undefined && !keys.includes(options.titleModel)) {
    const message = `[agent] agent.titleModel「${options.titleModel}」不在模型表里（现有：${keys.join('、')}），服务不启动`
    console.error(message)
    throw new Error(message)
  }

  const gateway = {
    url: agentGatewayUrl(options),
    secret: options.tokenSecret,
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
  }
  const disabled = (reason: string) => {
    console.warn(`[agent] 未启用：${reason}`)
    return createAgentRuntime({ model: null, disabled: reason, models, driver: NO_DRIVER, gateway, ...host })
  }

  const defaultThinking = thinkingOf(options)
  const defaultModel = resolveProviderModel({
    table: options.llmProviders,
    provider: options.provider,
    model: options.model,
    envVar: options.envVar,
    ...(defaultThinking !== undefined ? { thinking: defaultThinking } : {}),
  })
  // 入口 agent（canvas）的模型不可用 = agent 没开；别的 agent 的不可用到 run_agent 点名它时才报
  const entryKey = agentModelKey(host.agents.entry)
  const resolved = entryKey === DEFAULT_AGENT_MODEL ? defaultModel : models[entryKey]!
  if (!resolved.ok) return disabled(entryKey === DEFAULT_AGENT_MODEL ? resolved.reason : `入口 agent ${host.agents.entry.name} 的模型「${entryKey}」不可用：${resolved.reason}`)
  if (!built.ok) return disabled(built.reason)

  const runtime = createAgentRuntime({
    model: defaultModel.ok ? defaultModel.value : null,
    ...(defaultModel.ok ? {} : { disabledReason: defaultModel.reason }),
    models,
    driver: built.driver,
    gateway,
    mediaTool: options.sandboxExec,
    // 看图只读本服务的对象存储：没配 S3 就不接（工具也就不给模型）；还要模型吃图片，由编排层判
    ...(mediaReader ? { mediaReader } : {}),
    sandbox: { image: options.sandboxImage, resources: options.sandboxResources },
    // 空闲上限（docs/20 §3.10.8）；总时长上限（§3.10.11）：沙箱硬期限与 Grant 的绝对过期按它算
    limits: { idleTimeoutMs: options.runIdleTimeoutMs, totalTimeoutMs: options.runTotalTimeoutMs },
    ...(options.titleModel !== undefined ? { titleModel: options.titleModel } : {}),
    ...host,
  })
  if (!runtime.enabled) return disabled(runtime.disabledReason ?? '模型不可用')
  console.info(
    `[agent] 已启用：${resolved.value.model.provider}/${resolved.value.model.id}，沙箱驱动 ${built.driver.name}（runner 经 ${gateway.url}）` +
      `${options.sandboxExec ? '，媒体工具（ffmpeg / ffprobe）已开启' : ''}` +
      `${mediaReader && resolved.value.model.input.includes('image') ? '，看图（view_node_media）已开启' : ''}`,
  )
  if (built.driver.name === 'process') console.warn('[agent] process 沙箱驱动不是强隔离：runner 和服务端同一个用户、同一个文件系统、可以出网（docs/22 §4.2）')
  return runtime
}
