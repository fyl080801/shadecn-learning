import { CANVAS_SERVICE, underFlowGuard, type CanvasService } from '@shadecn/mod-canvas/contract'
import { STORAGE_SERVICE, type StorageService } from '@shadecn/mod-storage/contract'
import { AGENT_GATEWAY_PATH } from '@shadecn/agent/protocol'
import { users } from '@shadecn/server-kit/identity'
import { defineModule } from '@shadecn/server-kit/kernel'
import type { PlatformAuth, RuntimeInfo } from '@shadecn/server-kit/platform'
import { startAgentReconciler } from './authority.ts'
import { agentConfig, agentProviderApiKey, type AgentConfig } from './config.ts'
import { agentDefinitions, agentTextSkills } from './definitions.ts'
import { handleRunDispatch } from './dispatch.ts'
import { AgentConversation, AgentGrant, AgentGrantScope, AgentRun, AgentToolCall } from './entities.ts'
import { abortAgentRuns, startAgentSandboxReaper } from './index.ts'
import { agentModels } from './models.ts'
import { configureAgent } from './ports.ts'
import { createAgentGatewayRoutes, createAgentRoutes } from './routes.ts'
import { agentConversations, agentGrants, agentRunLog } from './stores.ts'

/** 面板、会话、发起、接回、中止：归 web（发起经总线派给 agent 副本，docs/28 §3.6） */
export const AGENT_PANEL_PATH = '/api/flows/:flowId/agent'

/**
 * 把 agent 的内部依赖拼好交给 `configureAgent`，并当场校验 agent 定义、文字技能、模型表（不合法就抛，进程不监听端口）。
 * 模块的 `setup` 调它；测试换一套环境变量重建 runtime 时也调它（`apps/server/test/agent/sandbox-config.test.ts`）。
 */
export function wireAgent(deps: {
  config: AgentConfig
  runtime: RuntimeInfo
  /** 没配 `AGENT_TOKEN_SECRET` 时由它从会话密钥派生签 run 令牌的密钥 */
  auth: Pick<PlatformAuth, 'deriveSecret'>
  executesRuns: boolean
  canvas: Pick<CanvasService, 'locate' | 'roleOf'>
  storage: StorageService | undefined
}): void {
  const { config, runtime, canvas, storage } = deps
  configureAgent({
    // 签 run 短令牌的 HMAC 密钥：显式配了用它，否则由会话密钥派生（加了域分隔，和会话的 HMAC 不是同一把）
    config: { ...config.host, tokenSecret: config.host.tokenSecret || deps.auth.deriveSecret('shadecn-agent-sts') },
    instanceId: runtime.instanceId,
    host: runtime.host,
    isDev: runtime.isDev,
    executesRuns: deps.executesRuns,
    paths: config.paths,
    providerApiKey: (provider, env) =>
      agentProviderApiKey(provider, env ? (name) => env[name] : (name) => runtime.envVar(name)),
    storage: { enabled: storage !== undefined, keyPrefix: storage?.keyPrefix ?? '' },
    runner: { isBundle: runtime.isBundle, moduleDir: runtime.moduleDir },
    stores: {
      conversations: agentConversations,
      runLog: agentRunLog,
      userProfiles: (ids) => users.briefs(ids),
      grants: agentGrants,
      // 和 `canvas.flowGuard` 同口径：画布（及其项目）没被删，且这个人是项目成员（个人空间即所有者）
      async flowAccess(flowId, userId) {
        const target = await canvas.locate(flowId)
        if (!target) return null
        return (await canvas.roleOf(target.projectId, userId)) ? target : null
      },
    },
  })
  // 触发惰性单例的加载 = 启动时校验（agent 定义引用的模型键要在模型表里，所以先模型表）
  void Object.keys(agentModels)
  void agentDefinitions.entry
  void agentTextSkills.skills
}

/**
 * 画布 agent 模块（REQ-AGENT / REQ-AGENT-SANDBOX，docs/28 §3.6）。
 *
 * - **随 `web` 和 `agent` 两个角色加载**：web 上是只读的 runtime（视图、会话、接回、中止经共享登记；发起只经派发，不建沙箱驱动），
 *   agent 上执行（接派发、对账、清孤儿沙箱、网关）。两类入口按声明的角色由内核分别挂。
 * - 硬依赖 canvas（判权、画布归属）；**只在执行角色上**硬依赖 collab：agent 经 direct connection 写活房间（`canvas-access.ts`），
 *   agent 角色的进程总带着一个 headless 的协同实例。软依赖 storage：没加载就没有附件和看图工具。
 * - 装配时就把 agent 定义、文字技能、模型表读出来校验一遍：不合法就抛，进程不监听端口（`.claude/rules/agent.md`）。
 *
 * 收尾在 collab 之前（内核按装配逆序）：在跑的轮次先叫停并等它们收尾 —— 已写进画布的改动保留（各自是独立的 Y 事务），
 * 房间随 collab 的落库一起存；这一轮的对话和运行日志要赶在关数据库之前写进去。上限 5 秒，和 collab 的 20 秒一起仍在 60 秒宽限期内。
 */
export default defineModule({
  name: 'agent',
  roles: ['web', 'agent'],
  dependsOn: ['canvas', { module: 'collab', roles: ['agent'] }],
  optional: ['storage'],
  config: agentConfig,
  entities: [AgentConversation, AgentRun, AgentToolCall, AgentGrant, AgentGrantScope],
  routes: [
    { path: AGENT_PANEL_PATH, role: 'web', access: 'user' },
    // runner 回连：只认 run 短令牌（沙箱里没有、也不该有 cookie），鉴权在网关里做；不经 ingress，直连 Pod IP
    { path: AGENT_GATEWAY_PATH, role: 'agent', access: 'public' },
  ],
  async setup(ctx) {
    const canvas = ctx.service<CanvasService>(CANVAS_SERVICE)!
    const storage = ctx.service<StorageService>(STORAGE_SERVICE)
    const executesRuns = ctx.roles.has('agent')
    wireAgent({ config: ctx.config, runtime: ctx.platform.runtime, auth: ctx.platform.auth, executesRuns, canvas, storage })

    const panel = createAgentRoutes({
      request: canvas.request,
      flowAssets: storage?.assets ?? { findInFlow: async () => [] },
    })
    ctx.http.route(AGENT_PANEL_PATH, underFlowGuard(canvas, panel))
    ctx.http.route(AGENT_GATEWAY_PATH, createAgentGatewayRoutes())
    if (!executesRuns) return

    // 发起一轮：web 经总线派给某个 agent 副本（dispatch.ts）。只有执行角色登记
    const stopDispatch = await handleRunDispatch()
    // 委托授权：每 10 分钟全量对账一次（过期的标掉、失权的叫停；权限变化事件那条路是当场的，见 authority.ts）
    const stopReconciler = startAgentReconciler()
    // 沙箱：oci / k8s 驱动先自检（引擎 / 镜像 / 网络），再清上一个进程留下的孤儿容器，之后定时清
    const stopReaper = startAgentSandboxReaper()
    return {
      shutdownTimeoutMs: 5_000,
      async shutdown() {
        // 先撤登记：退出过程中不再接新的一轮
        await stopDispatch()
        stopReconciler()
        stopReaper()
        await abortAgentRuns('服务正在重启')
      },
    }
  },
})
