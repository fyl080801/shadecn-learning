import type { Hocuspocus } from '@hocuspocus/server'
import * as Y from 'yjs'
import { formatAppTasksMessage, type AppOutputView, type AppTaskProgress } from '@shadecn/shared/apps'
import { nodesMap } from '@shadecn/shared/flow-doc'
import { opContext, recordGeneration, writeNodeFields, type FlowOpContext } from '@shadecn/shared/flow-ops'
import { collabInstance, quotaLocked, roomOf } from '@shadecn/mod-collab/canvas-host'
import type { StorageService } from '@shadecn/mod-storage/contract'
import { bus } from '@shadecn/server-kit/bus'
import { AppError, type AppOutput, type AppResult, type AppsService, type TaskHandle } from './contract.ts'
import { inlineFlowAssets, persistFlowOutputs } from './flow-assets.ts'
import { APPS_CANCEL_TASK, APPS_PUSH_TASKS, APPS_RUN_TASK } from './task-bus.ts'
import { isTaskRevoked, type TaskAuthorities, type TaskAuthority } from './task-authority.ts'
import { appTasks, handleOf, paramsOf, taskViews, type AppTaskRow } from './tasks.ts'

/**
 * 画布生成任务的执行侧（docs/29 §3.10）—— **只在 agent 角色上**：它带着 headless 协同实例，能经 direct connection 写活房间。
 *
 * ## 生命周期
 *
 * web 建好任务行，经总线 `APPS_RUN_TASK` 派给一个 agent 副本；副本 `claim` 抢到租约就执行，抢不到（别人已接手 / 已结束）什么都不做。
 * 派发丢了 / 副本崩了也不要紧：每个 agent 副本定时**对账**（{@link startTaskSweeper}），进行中且租约过期的任务由它接手 ——
 * 有续查句柄的接着查（`resumeApp`，不重新提交），没有句柄却已经 `running` 的（同步上游调到一半进程没了）记失败。
 *
 * 一次执行：按发起人签执行身份（`task-authority.ts`，发起人此刻进不了画布就不执行）→ 开 direct connection（钉住房间：推送要从持有房间的副本发出）→
 * `running` + 节点写 `processing` → 推送 → 参考图换字节 → `executeApp`（句柄存表、进度存表并推送）→ 产物存成画布资源 → 任务行收尾 →
 * 写回节点 → 推送 → 断开（断开即落库）。
 *
 * **节点的 `runtime` 只有这里写**（前端不写）：`processing` 的意思就是「执行副本已经在跑」，排队中只在任务列表里。
 *
 * ## 执行身份：凭发起人
 *
 * 整个执行凭的是发起人签的那一份（同画布 agent 的 Grant，docs/22 §5）：读参考图之前判 `flow:read`，存产物、每次写节点之前判 `flow:write`，
 * 每次续租顺带判一次；发起人失权（被移出项目、画布或项目被删、画布挪走）→ 当场叫停：撤上游、任务记失败，**不再写节点**（已经无权写了）。
 * 和登录态无关：退出登录、会话过期不影响在跑的任务。
 *
 * ## 停下来的四种原因（`AbortController` 的 reason）
 *
 * - `canceled`：有人取消了（总线 `APPS_CANCEL_TASK` 立刻到，或者续租时读到）—— 尽力撤销上游任务，节点改回 `idle`；
 * - `revoked`：发起人失权（判权时发现，或权限变化事件的对账）—— 尽力撤销上游任务，任务记失败，不碰节点；
 * - `lost`：租约没了却不是取消（被别的副本接手）—— 什么都不写，让持有者去写；
 * - `shutdown`：进程要退出 —— 放掉租约，别的副本 / 重启后的自己马上接手（有句柄的续查）。
 *
 * ## 写回节点的规矩
 *
 * 只经 `@shadecn/shared/flow-ops`（`recordGeneration` → `attachAsset` 守住 generate / asset 形态规则，同人上传），事务 origin 是 {@link appsOrigin} ——
 * 不在任何人的 `trackedOrigins` 里，不进撤销栈。写之前判：发起人的执行身份过 `flow:write`、房间没到容量上限、节点还在、
 * 节点的 `runtime.taskId` 还是这个任务（被更新的任务盖掉了就不碰）。写不了只打日志，任务结果照常记在表里。
 */

/** 租约时长；续租按它的 1/3 */
export const TASK_LEASE_MS = 30_000
/** 对账间隔 */
export const TASK_SWEEP_INTERVAL_MS = 15_000
const SWEEP_BATCH = 20

export interface AppsOrigin {
  source: 'apps'
  taskId: string
}

/** 写回节点的事务 origin（纯标记：不是 `LOCAL_ORIGIN`，所以不进任何人的撤销栈） */
export const appsOrigin = (taskId: string): AppsOrigin => ({ source: 'apps', taskId })

export interface TaskRunnerPorts {
  service: AppsService
  /** 按发起人签执行身份、判权（`task-authority.ts`） */
  authorities: TaskAuthorities
  storage(): StorageService | undefined
  instanceId: string
  /** 测试注入；缺省取本进程的协同实例 */
  hocuspocus?: () => Hocuspocus | null
  /** 租约 / 对账的时长（测试缩短） */
  leaseMs?: number
}

type StopReason = 'canceled' | 'revoked' | 'lost' | 'shutdown'

interface Running {
  controller: AbortController
  done: Promise<void>
}

export interface TaskRunner {
  /** 抢租约并执行；抢不到返回 false */
  runTask(taskId: string): Promise<boolean>
  /** 本副本在跑它就停下（取消） */
  abortTask(taskId: string, reason: StopReason): boolean
  /** 对账一次：接手租约过期的进行中任务 */
  sweep(): Promise<void>
  /** 推送一次这张画布的任务列表（排队中被取消的任务没有执行方替它推送） */
  pushTasks(flowId: string): Promise<void>
  /** 本副本在跑的任务 id */
  running(): string[]
  /** 进程退出：停下全部、放掉租约，等它们收尾 */
  shutdown(): Promise<void>
}

export function createTaskRunner(ports: TaskRunnerPorts): TaskRunner {
  const leaseMs = ports.leaseMs ?? TASK_LEASE_MS
  const owner = ports.instanceId
  const hocuspocus = ports.hocuspocus ?? collabInstance
  const running = new Map<string, Running>()
  /** 每张画布的推送排成一队：后发的一定不比先发的旧 */
  const broadcastChains = new Map<string, Promise<void>>()

  function broadcast(flowId: string): Promise<void> {
    const previous = broadcastChains.get(flowId) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        const document = hocuspocus()?.documents.get(roomOf(flowId))
        if (!document) return
        const views = await taskViews(await appTasks.listActive(flowId), ports.service)
        document.broadcastStateless(formatAppTasksMessage(flowId, views))
      })
      .catch((err: unknown) => console.warn(`[apps] 推送画布 ${flowId} 的任务列表失败`, err))
    broadcastChains.set(flowId, next)
    void next.then(() => {
      if (broadcastChains.get(flowId) === next) broadcastChains.delete(flowId)
    })
    return next
  }

  async function runClaimed(row: AppTaskRow, controller: AbortController): Promise<void> {
    const signal = controller.signal
    const reason = (): StopReason | null => (signal.aborted ? (signal.reason as StopReason) : null)
    const room = roomOf(row.flowId)
    let handle = handleOf(row)
    let connection: Awaited<ReturnType<Hocuspocus['openDirectConnection']>> | null = null
    let authority: TaskAuthority | null = null
    /** 发起人失权的原因（`revoked` 时写进任务行） */
    let revokedReason = ''

    /** 在房间里写这个节点；条件不满足就跳过（只打日志） */
    const writeNode = async (label: string, fn: (ctx: FlowOpContext, runtime: Y.Map<unknown> | undefined) => boolean | void) => {
      const doc = connection?.document
      if (!doc || !authority) return
      try {
        // 凭发起人写：失权的在这里被拦下（并叫停任务）
        await authority.authorize('flow:write')
        const locked = quotaLocked(room)
        if (locked) return console.warn(`[apps] 任务 ${row.id}：画布 ${row.flowId} 已到容量上限，不写回节点（${label}）：${locked}`)
        const ctx = opContext(doc)
        const node = nodesMap(doc).get(row.nodeId)
        if (!(node instanceof Y.Map)) return
        const runtime = node.get('runtime')
        doc.transact(() => {
          fn(ctx, runtime instanceof Y.Map ? (runtime as Y.Map<unknown>) : undefined)
        }, appsOrigin(row.id))
      } catch (err) {
        console.warn(`[apps] 任务 ${row.id} 写回节点失败（${label}）`, err)
      }
    }
    /** 节点的 runtime 还指着这个任务 */
    const ownsNode = (runtime: Y.Map<unknown> | undefined) => runtime?.get('taskId') === row.id

    const renew = setInterval(() => {
      void appTasks
        .renew(row.id, owner, leaseMs)
        .then(async (ok) => {
          if (ok || signal.aborted) return
          const current = await appTasks.get(row.id)
          controller.abort(current?.status === 'canceled' ? 'canceled' : 'lost')
        })
        .catch((err: unknown) => console.warn(`[apps] 任务 ${row.id} 续租失败（下次再试）`, err))
      // 顺带按发起人判一次：失权的当场叫停（判权里经 stop 回调）
      authority?.authorize('flow:read').catch((err: unknown) => {
        if (!isTaskRevoked(err)) console.warn(`[apps] 任务 ${row.id} 续租时判权失败（下次再试）`, err)
      })
    }, Math.max(1_000, Math.floor(leaseMs / 3)))

    try {
      // 按发起人签执行身份：此刻就进不了画布 → 抛出，任务记失败，不开房间、不调上游
      authority = await ports.authorities.issue({
        taskId: row.id,
        flowId: row.flowId,
        userId: row.userId,
        stop(reason) {
          revokedReason = reason
          controller.abort('revoked')
        },
      })
      const instance = hocuspocus()
      if (instance) {
        connection = await instance.openDirectConnection(room, { apps: { taskId: row.id, userId: row.userId } })
      } else {
        console.warn(`[apps] 本进程没有协同实例，任务 ${row.id} 的结果写不回节点`)
      }
      const wasRunning = row.status === 'running'
      const startedAt = await appTasks.start(row, owner)
      await writeNode('开始', (ctx, runtime) => {
        // 节点上另有一个在跑的任务（不该发生：同一节点只许一个）就不抢
        const other = runtime?.get('taskId')
        if (runtime?.get('status') === 'processing' && typeof other === 'string' && other !== row.id) return
        writeNodeFields(ctx, row.nodeId, 'runtime', { set: { status: 'processing', taskId: row.id }, remove: ['error'] })
      })
      void broadcast(row.flowId)

      const onProgress = (progress: AppTaskProgress) => {
        void appTasks
          .saveProgress(row.id, owner, progress)
          .then(() => broadcast(row.flowId))
          .catch((err: unknown) => console.warn(`[apps] 任务 ${row.id} 的进度没存上`, err))
      }

      let result: AppResult
      if (handle) {
        result = await ports.service.resumeApp(row.appId, handle, { signal, startedAt: startedAt.getTime(), userId: row.userId, onProgress })
      } else if (wasRunning) {
        // 同步上游调到一半、进程没了：结果拿不回来，也不重复提交（会重复扣费）
        throw new AppError('aborted', '执行中断（服务重启），请重新生成')
      } else {
        const app = ports.service.get(row.appId)
        if (!app) throw new AppError('not_found', `应用 ${row.appId} 已经不在应用表里了`)
        await authority.authorize('flow:read')
        const params = await inlineFlowAssets(ports.storage(), row.flowId, app, paramsOf(row), signal)
        result = await ports.service.executeApp(row.appId, params, {
          signal,
          startedAt: startedAt.getTime(),
          userId: row.userId,
          onProgress,
          onSubmitted: async (next) => {
            handle = next
            await appTasks.saveHandle(row.id, owner, next)
          },
        })
      }

      // 产物存成这张画布的资源 = 往画布里写：凭发起人判
      await authority.authorize('flow:write')
      const persisted = await persistFlowOutputs(ports.storage(), { flowId: row.flowId, userId: row.userId, result })
      const outputs = persisted.outputs.map(outputView)
      if (!(await appTasks.finish(row.id, owner, { status: 'succeeded', outputs }))) return
      const category = ports.service.get(row.appId)?.category
      const output = outputs.find((item) => item.kind === category && item.url)
      // 视频节点画的是预览图：产物里有图（尾帧）就当预览图
      const poster = category === 'video' ? outputs.find((item) => item.kind === 'image' && item.url)?.url : undefined
      await writeNode('完成', (ctx, runtime) => {
        if (!ownsNode(runtime)) return
        if (output?.url) {
          // 挂上结果并留进生成历史（同一个事务；id = 任务 id，被接手后重写也只有一条）
          recordGeneration(ctx, row.nodeId, { id: row.id, src: output.url, ...(poster ? { poster } : {}), createdAt: Date.now() })
          writeNodeFields(ctx, row.nodeId, 'runtime', { set: { status: 'completed' }, remove: ['error'] })
        } else {
          writeNodeFields(ctx, row.nodeId, 'runtime', { set: { status: 'error', error: '应用没有返回可以放进这个节点的结果' } })
        }
      })
    } catch (err) {
      const stopped = reason()
      if (stopped === 'canceled') {
        if (handle) await ports.service.cancelUpstream(row.appId, handle)
        await writeNode('取消', (ctx, runtime) => {
          if (ownsNode(runtime)) writeNodeFields(ctx, row.nodeId, 'runtime', { set: { status: 'idle' }, remove: ['error'] })
        })
      } else if (stopped === 'revoked') {
        // 发起人无权了：撤上游、任务记失败；节点不碰（无权写）
        if (handle) await ports.service.cancelUpstream(row.appId, handle)
        await appTasks.finish(row.id, owner, { status: 'failed', error: revokedReason })
      } else if (stopped === 'shutdown') {
        await appTasks.release(row.id, owner).catch((error: unknown) => console.warn(`[apps] 任务 ${row.id} 放租约失败`, error))
      } else if (stopped === null) {
        const message = err instanceof AppError || isTaskRevoked(err) ? err.message : `执行出错：${err instanceof Error ? err.message : String(err)}`
        if (!(err instanceof AppError) && !isTaskRevoked(err)) console.error(`[apps] 任务 ${row.id} 执行出错`, err)
        if (await appTasks.finish(row.id, owner, { status: 'failed', error: message })) {
          await writeNode('失败', (ctx, runtime) => {
            if (ownsNode(runtime)) writeNodeFields(ctx, row.nodeId, 'runtime', { set: { status: 'error', error: message } })
          })
        }
      }
    } finally {
      clearInterval(renew)
      authority?.release()
      await broadcast(row.flowId)
      // 断开时 Hocuspocus 立刻跑一次 store（不等防抖），没有别的连接就卸载房间 —— 写回在这里确定落库
      await connection?.disconnect().catch((err: unknown) => console.warn(`[apps] 任务 ${row.id} 断开画布连接失败`, err))
    }
  }

  function start(row: AppTaskRow): void {
    const controller = new AbortController()
    const done = runClaimed(row, controller)
      .catch((err: unknown) => console.error(`[apps] 任务 ${row.id} 收尾失败`, err))
      .finally(() => {
        if (running.get(row.id)?.controller === controller) running.delete(row.id)
      })
    running.set(row.id, { controller, done })
  }

  return {
    async runTask(taskId) {
      if (running.has(taskId)) return true
      if (!(await appTasks.claim(taskId, owner, leaseMs))) return false
      const row = await appTasks.get(taskId)
      if (!row) return false
      start(row)
      return true
    },
    abortTask(taskId, reason) {
      const entry = running.get(taskId)
      if (!entry) return false
      entry.controller.abort(reason)
      return true
    },
    async sweep() {
      const rows = await appTasks.reclaimable(SWEEP_BATCH)
      for (const row of rows) {
        if (running.has(row.id)) continue
        if (await appTasks.claim(row.id, owner, leaseMs)) {
          console.info(`[apps] 接手任务 ${row.id}（${row.status}${row.handle ? '，有续查句柄' : ''}）`)
          start((await appTasks.get(row.id)) ?? row)
        }
      }
    },
    async pushTasks(flowId) {
      const instance = hocuspocus()
      if (!instance) return
      const room = roomOf(flowId)
      if (instance.documents.get(room)) return broadcast(flowId)
      // 本副本没有这个房间：短暂开一条 direct connection（经 redis 扩展转发给持有房间的副本），推完断开
      const connection = await instance.openDirectConnection(room, { apps: { push: true } })
      try {
        await broadcast(flowId)
      } finally {
        await connection.disconnect().catch((err: unknown) => console.warn(`[apps] 推送画布 ${flowId} 后断开连接失败`, err))
      }
    },
    running: () => [...running.keys()],
    async shutdown() {
      const entries = [...running.values()]
      for (const entry of entries) entry.controller.abort('shutdown')
      await Promise.allSettled(entries.map((entry) => entry.done))
    },
  }
}

function outputView({ data, ...rest }: AppOutput): AppOutputView {
  // 存不进资源的字节产物不进任务表（几十 MB 的 base64 没有意义）；画布节点只认地址
  return data ? { ...rest, meta: { ...rest.meta, dropped: 'bytes' } } : rest
}

/** 登记总线处理函数（agent 角色的 setup 调）：执行派发、取消通知。返回撤销函数 */
export async function handleTaskBus(runner: TaskRunner): Promise<() => Promise<void>> {
  const stopRun = await bus().handle(APPS_RUN_TASK, async ({ taskId }) => ({ accepted: await runner.runTask(taskId) }))
  const stopCancel = await bus().handle(APPS_CANCEL_TASK, ({ taskId }) => ({ aborted: runner.abortTask(taskId, 'canceled') }))
  const stopPush = await bus().handle(APPS_PUSH_TASKS, async ({ flowId }) => {
    await runner.pushTasks(flowId)
    return { pushed: true }
  })
  return async () => {
    await stopRun()
    await stopCancel()
    await stopPush()
  }
}

/** 定时对账（启动时先跑一次）。返回停止函数 */
export function startTaskSweeper(runner: TaskRunner, intervalMs = TASK_SWEEP_INTERVAL_MS): () => void {
  let busy = false
  const tick = () => {
    if (busy) return
    busy = true
    void runner
      .sweep()
      .catch((err: unknown) => console.warn('[apps] 任务对账失败（下次再试）', err))
      .finally(() => {
        busy = false
      })
  }
  const first = setTimeout(tick, 1_000)
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  first.unref?.()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}

export type { TaskHandle }
