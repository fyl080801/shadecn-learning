import { startAgentReconciler } from '../agent/authority.ts'
import { abortAgentRuns, startAgentSandboxReaper } from '../agent/index.ts'
import { defineModule } from '../kernel/module.ts'

/**
 * 画布 agent 模块（REQ-AGENT / REQ-AGENT-SANDBOX）。
 *
 * - 硬依赖 collab：agent 经 direct connection 写活房间（`agent/canvas-access.ts`）；
 * - 软依赖 storage：没配 S3 就没有看图工具（`agent/media.ts` 自己判 `s3Enabled`）。
 *
 * 收尾在 collab 之前（内核按装配逆序）：在跑的轮次先叫停并等它们收尾 —— 已写进画布的改动保留（各自是独立的 Y 事务），
 * 房间随 collab 的落库一起存；这一轮的对话和运行日志要赶在关数据库之前写进去。中止是立刻的，收尾只是几次写库，
 * 上限 5 秒，和 collab 的 20 秒一起仍在 60 秒宽限期之内。
 */
export const agentModule = defineModule({
  name: 'agent',
  roles: ['agent'],
  dependsOn: ['collab'],
  optional: ['storage'],
  setup() {
    // 委托授权：每 10 分钟全量对账一次（过期的标掉、失权的叫停；权限变化事件那条路是当场的，见 agent/authority.ts）
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
