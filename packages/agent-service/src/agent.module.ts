import { setTimeout as sleep } from 'node:timers/promises'
import type { AgentCapability } from '@learning/agent-core/authority'
import type { AgentRegistry } from '@learning/agent-core/agents'
import type { AgentRuntime } from '@learning/agent-core/session'
import type { TextSkillRegistry } from '@learning/agent-core/text-skills'
import { CanvasModule } from '@learning/canvas'
import { CollabModule } from '@learning/collab'
import { ConfigService } from '@learning/config'
import { DATA_ACCESS_ENTITIES } from '@learning/data-access'
import { SessionService, UserService } from '@learning/session'
import { AssetStorage, StorageModule } from '@learning/storage'
import { Inject, Module, type OnModuleDestroy } from '@nestjs/common'
import { AgentController } from './agent.controller.js'
import { AGENT_AUTHORITY_OPTIONS, AgentAuthorities, type AgentAuthorityOptions } from './authority.js'
import { AgentCanvasAccess } from './canvas-access.js'
import { AGENT_DEFINITIONS, AGENT_TEXT_SKILLS, loadAgentDefinitions, loadAgentTextSkills } from './definitions.js'
import { AGENT_ENTITIES } from './entities.js'
import { AgentGatewayMount } from './gateway-mount.js'
import { AgentLeases } from './leases.js'
import { AgentMediaReader } from './media.js'
import { AGENT_MODELS, type AgentModels, loadAgentModels } from './models.js'
import { AGENT_OPTIONS, type AgentOptions, resolveAgentOptions } from './options.js'
import { AgentRuns } from './runs.js'
import { AGENT_HOST_OPTIONS, type AgentHostOptions, buildAgentRuntime } from './runtime.js'
import { AGENT_RUNTIME, AgentSandboxReaper, type BuiltDriver, buildSandboxDriver, SANDBOX_DRIVER } from './sandbox.js'
import { AgentSseStreams } from './sse.js'
import { AgentConversations, AgentGrants, AgentRunLog } from './stores.js'

/** 退出时等在跑的轮次收尾的上限：和协同的 20 秒一起仍在 k8s 的 60 秒宽限期内 */
export const AGENT_SHUTDOWN_TIMEOUT_MS = 5_000

/**
 * 画布 agent 的编排（docs/20、docs/22、docs/31 §4.2）。依赖全局底座（`ConfigModule`、`DataAccessModule`、`ClusterModule`、`SessionIdentityModule`），不用 import。
 *
 * - import `CollabModule` 只为房间：一轮经 direct connection 写活房间，这个模块单独用时进程里没有 WebSocket 入口，同 `AppsModule`；
 * - **校验放工厂里**：定义、文字技能、模型表坏了拒绝启动，启用与否都一样。一个都不配也照样加载（`enabled: false`）；
 * - 只有 import 这个模块的进程才建 agent 的表；
 * - 两个 HTTP 入口（docs/31 §4.3）：面板是 `AgentController`，网关是 `AgentGatewayMount`（Fastify 普通路由，不过会话守卫）。
 */
@Module({
  imports: [CanvasModule, CollabModule, StorageModule],
  controllers: [AgentController],
  providers: [
    { provide: DATA_ACCESS_ENTITIES, useValue: AGENT_ENTITIES },
    { provide: AGENT_OPTIONS, inject: [ConfigService, SessionService], useFactory: resolveAgentOptions },
    { provide: AGENT_MODELS, inject: [AGENT_OPTIONS], useFactory: loadAgentModels },
    { provide: AGENT_DEFINITIONS, inject: [AGENT_OPTIONS, AGENT_MODELS], useFactory: loadAgentDefinitions },
    { provide: AGENT_TEXT_SKILLS, inject: [AGENT_OPTIONS], useFactory: loadAgentTextSkills },
    AgentConversations,
    AgentRunLog,
    AgentGrants,
    {
      provide: AGENT_AUTHORITY_OPTIONS,
      inject: [AGENT_OPTIONS],
      useFactory: (options: AgentOptions): AgentAuthorityOptions => ({
        expiryMarginMs: options.grantMarginMs,
        // 没开媒体工具就不授 sandbox:exec；模型能不能用由 runtime 是否启用决定（没启用根本不会签发）
        entitled: (capability: AgentCapability) => capability !== 'sandbox:exec' || options.sandboxExec,
      }),
    },
    AgentAuthorities,
    AgentLeases,
    AgentRuns,
    AgentMediaReader,
    AgentCanvasAccess,
    { provide: SANDBOX_DRIVER, inject: [AGENT_OPTIONS], useFactory: buildSandboxDriver },
    {
      provide: AGENT_HOST_OPTIONS,
      inject: [AgentConversations, AgentRunLog, UserService, AgentCanvasAccess, AgentAuthorities, AgentLeases, AgentRuns, AGENT_DEFINITIONS, AGENT_TEXT_SKILLS],
      useFactory: (
        store: AgentConversations,
        runLog: AgentRunLog,
        users: UserService,
        canvas: AgentCanvasAccess,
        authorities: AgentAuthorities,
        leases: AgentLeases,
        runRegistry: AgentRuns,
        agents: AgentRegistry,
        textSkills: TextSkillRegistry,
      ): AgentHostOptions => ({
        store,
        runLog,
        userProfiles: (ids) => users.briefs(ids),
        onRunsChange: (flowId, runs) => {
          canvas.broadcastRuns(flowId, runs)
        },
        authorities,
        leases,
        runRegistry,
        agents,
        textSkills,
      }),
    },
    {
      provide: AGENT_RUNTIME,
      inject: [AGENT_OPTIONS, SANDBOX_DRIVER, AGENT_MODELS, AGENT_HOST_OPTIONS, AgentMediaReader, AssetStorage],
      useFactory: (options: AgentOptions, built: BuiltDriver, models: AgentModels, host: AgentHostOptions, reader: AgentMediaReader, storage: AssetStorage) =>
        buildAgentRuntime(options, built, models, host, storage.available ? reader : undefined),
    },
    AgentSandboxReaper,
    AgentSseStreams,
    AgentGatewayMount,
  ],
})
export class AgentModule implements OnModuleDestroy {
  constructor(
    @Inject(AGENT_RUNTIME) private readonly runtime: AgentRuntime,
    @Inject(AgentSseStreams) private readonly streams: AgentSseStreams,
  ) {}

  /**
   * 退出：中止在跑的轮次并等它们收尾（对话落库、运行日志写完、画布关掉），已写进画布的改动保留。
   * **放在 `onModuleDestroy`，不放 `beforeApplicationShutdown`**：一轮收尾要断开 direct connection（落库、卸载），而 `CollabServer` 在后者关房间和 Redis 扩展，ORM 还在更后面。
   * Nest 走完全部模块的 `onModuleDestroy` 才进下一阶段，所以不依赖模块顺序。收不了尾的不能挡住退出，内容已由协同那边尽力写过。
   *
   * 这之后到 HTTP 关闭之前端口还开着（Nest 的顺序），所以先 `beginDrain`：新的一轮回 503，不然它会在协同关房间的途中打开房间。
   * 最后结束所有 SSE：响应没结束，`app.close()` 就不返回（`AgentSseStreams`）。
   */
  async onModuleDestroy(): Promise<void> {
    this.streams.beginDrain()
    const settled = await Promise.race([
      this.runtime.abortAll('服务正在重启').then(() => this.streams.startsSettled()).then(
        () => true,
        (err: unknown) => {
          console.error('[agent] 退出时收尾失败', err)
          return true
        },
      ),
      sleep(AGENT_SHUTDOWN_TIMEOUT_MS, false, { ref: false }),
    ])
    if (!settled) console.warn(`[agent] 退出时在跑的轮次超过 ${AGENT_SHUTDOWN_TIMEOUT_MS} 毫秒没收尾，不等了`)
    await this.streams.closeAll()
  }
}
