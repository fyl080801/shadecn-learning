import { defineModule, type ServerModule } from '@shadecn/server-kit/kernel'
import { startAgentReconciler } from './authority.ts'
import { agentDefinitions, agentTextSkills } from './definitions.ts'
import { abortAgentRuns, startAgentSandboxReaper } from './index.ts'
import { agentModels } from './models.ts'
import { configureAgent, type AgentPorts } from './ports.ts'

/**
 * 画布 agent 模块（REQ-AGENT / REQ-AGENT-SANDBOX，docs/28 §3.6）。宿主交进来端口（`apps/server/modules/agent.ts`）。
 *
 * - 硬依赖 collab：agent 经 direct connection 写活房间（`canvas-access.ts`）；agent 角色的进程里协同以 headless 跑。
 * - 软依赖 storage：没配对象存储就没有看图工具（`storage.enabled` 为 false）。
 *
 * **构造时就装配端口，并把 agent 定义、文字技能、模型表读出来校验一遍**：不合法就抛，进程不监听端口 ——
 * 和搬进这个包之前「import 时校验」的行为一致（`.claude/rules/agent.md`）。
 *
 * 收尾在 collab 之前（内核按装配逆序）：在跑的轮次先叫停并等它们收尾 —— 已写进画布的改动保留（各自是独立的 Y 事务），
 * 房间随 collab 的落库一起存；这一轮的对话和运行日志要赶在关数据库之前写进去。上限 5 秒，和 collab 的 20 秒一起仍在 60 秒宽限期内。
 */
export function createAgentModule<App>(ports: AgentPorts): ServerModule<App> {
  configureAgent(ports)
  // 触发惰性单例的加载 = 启动时校验（agent 定义引用的模型键要在模型表里，所以先模型表）
  void Object.keys(agentModels)
  void agentDefinitions.entry
  void agentTextSkills.skills
  return defineModule<App>({
    name: 'agent',
    roles: ['agent'],
    dependsOn: ['collab'],
    optional: ['storage'],
    setup() {
      // 委托授权：每 10 分钟全量对账一次（过期的标掉、失权的叫停；权限变化事件那条路是当场的，见 authority.ts）
      const stopReconciler = startAgentReconciler()
      // 沙箱：oci / k8s 驱动先自检（引擎 / 镜像 / 网络），再清上一个进程留下的孤儿容器，之后定时清
      const stopReaper = startAgentSandboxReaper()
      return {
        shutdownTimeoutMs: 5_000,
        async shutdown() {
          stopReconciler()
          stopReaper()
          await abortAgentRuns('服务正在重启')
        },
      }
    },
  })
}
