import { AccessRevocation } from '@learning/canvas'
import { Cluster } from '@learning/cluster'
import { CollabServer, roomOf } from '@learning/collab'
import { type AppOutputView, type AppTaskProgress, formatAppTasksMessage } from '@learning/contracts/apps'
import { nodesMap } from '@learning/contracts/flow-doc'
import { type FlowOpContext, opContext, writeNodeFields } from '@learning/contracts/flow-ops-core'
import { AssetStorage } from '@learning/storage'
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { setTimeout as sleep } from 'node:timers/promises'
import * as Y from 'yjs'
import { AppsService } from './apps.service.js'
import { AppError, type AppOutput, type AppResult } from './contract.js'
import { inlineFlowAssets, persistFlowOutputs } from './flow-assets.js'
import { appendGeneratedText, recordGeneration } from './generation-ops.js'
import { isTaskRevoked, TaskAuthorities, type TaskAuthority } from './task-authority.js'
import { APPS_CANCEL_TASK } from './task-bus.js'
import { type AppTaskRow, AppTasks, handleOf, paramsOf } from './tasks.js'

export const TASK_RUNNER_OPTIONS = Symbol('TASK_RUNNER_OPTIONS')

export interface TaskRunnerOptions {
  /** 租约时长；续租按它的 1/3 */
  leaseMs: number
  /** 对账间隔 */
  sweepIntervalMs: number
  /** 启动后多久对账第一次：上一个进程留下的任务在这里被接手 */
  firstSweepMs: number
  /** 退出时等在跑的任务收尾的上限 */
  shutdownTimeoutMs: number
}

export const DEFAULT_TASK_RUNNER_OPTIONS: TaskRunnerOptions = { leaseMs: 30_000, sweepIntervalMs: 15_000, firstSweepMs: 1_000, shutdownTimeoutMs: 5_000 }

const SWEEP_BATCH = 20
/** 排队中的任务被取消后补推一次列表：路由最多等它这么久 */
const PUSH_WAIT_MS = 3_000

export interface AppsOrigin {
  source: 'apps'
  taskId: string
}

/** 写回节点的事务 origin（纯标记：不是任何人的 `LOCAL_ORIGIN`，所以不进撤销栈） */
export const appsOrigin = (taskId: string): AppsOrigin => ({ source: 'apps', taskId })

export type StopReason = 'canceled' | 'revoked' | 'lost' | 'shutdown'

interface Running {
  controller: AbortController
  done: Promise<void>
}

/**
 * 画布生成任务的执行侧（docs/29 §3.10、docs/30 §8）。**受理和执行在同一个进程**：`AppsModule` 只在平台上，路由建好任务行就调 {@link runTask}；
 * 派发丢了也好、进程崩了也好，每个进程定时**对账**（{@link sweep}），进行中且租约过期的任务由它接手 ——
 * 有续查句柄的接着查（`resumeApp`，不重新提交），没有句柄却已经 `running` 的（同步上游调到一半进程没了）记失败。
 *
 * 一次执行：按发起人签执行身份（`task-authority.ts`，发起人此刻进不了画布就不执行）→ 开 direct connection（钉住房间）→
 * `running` + 节点写 `processing` → 推送 → 参考图换字节 → `executeApp`（句柄存表、进度存表并推送）→ 产物存成画布资源 → 任务行收尾 →
 * 写回节点 → 推送 → 断开（断开即落库）。
 *
 * **节点的 `runtime` 只有这里写**（前端不写）：`processing` 的意思就是「执行方已经在跑」，排队中只在任务列表里。
 *
 * ## 房间在哪
 *
 * 写节点要进 Y.Doc，所以平台进程里有一个没有 WebSocket 入口的 Hocuspocus（`CollabModule`）。拆开部署时用户都连在协同副本上，平台的这条 direct connection
 * 经 Redis 扩展和它们同步：开房间时 `afterLoadDocument` 等别的副本把内存里的状态推过来，写进去的更新和 `broadcastStateless` 都转发给持有房间的副本。
 *
 * ## 执行身份：凭发起人
 *
 * 读参考图之前判 `flow:read`，存产物、每次写节点之前判 `flow:write`，每次续租顺带判一次；
 * 发起人失权（被移出项目、画布或项目被删、画布挪走）→ 当场叫停：撤上游、任务记失败，**不再写节点**（已经无权写了）。
 * 和登录态无关：退出登录、会话过期不影响在跑的任务。
 *
 * ## 停下来的四种原因（`AbortController` 的 reason）
 *
 * - `canceled`：有人取消了（总线 `APPS_CANCEL_TASK` 立刻到，或者续租时读到）—— 尽力撤销上游任务，节点改回 `idle`；
 * - `revoked`：发起人失权 —— 尽力撤销上游任务，任务记失败，不碰节点；
 * - `lost`：租约没了却不是取消（被别的进程接手）—— 什么都不写，让持有者去写；
 * - `shutdown`：进程要退出 —— 放掉租约，别的进程 / 重启后的自己马上接手（有句柄的续查）。
 *
 * ## 写回节点的规矩
 *
 * 只经 `generation-ops.ts`（`recordGeneration` → `attachAsset` 守住 generate / asset 形态规则，同人上传；文字产物是 `appendGeneratedText`）和 `writeNodeFields`，事务 origin 是 {@link appsOrigin}。
 * 写之前判：发起人的执行身份过 `flow:write`、房间没到容量上限、节点还在、节点的 `runtime.taskId` 还是这个任务（被更新的任务盖掉了就不碰）。写不了只打日志，任务结果照常记在表里。
 */
@Injectable()
export class TaskRunner implements OnModuleInit, OnModuleDestroy {
  private readonly owner: string
  private readonly runningTasks = new Map<string, Running>()
  /** 每张画布的推送排成一队：后发的一定不比先发的旧 */
  private readonly broadcastChains = new Map<string, Promise<void>>()
  private stopping = false
  private sweeping = false
  private timers: NodeJS.Timeout[] = []
  private stopRevocation: (() => void) | undefined
  private stopCancelHandler: (() => Promise<void>) | undefined

  constructor(
    @Inject(AppsService) private readonly service: AppsService,
    @Inject(AppTasks) private readonly tasks: AppTasks,
    @Inject(TaskAuthorities) private readonly authorities: TaskAuthorities,
    @Inject(AssetStorage) private readonly storage: AssetStorage,
    @Inject(CollabServer) private readonly collab: CollabServer,
    @Inject(AccessRevocation) private readonly revocation: AccessRevocation,
    @Inject(Cluster) private readonly cluster: Cluster,
    @Inject(TASK_RUNNER_OPTIONS) private readonly options: TaskRunnerOptions,
  ) {
    this.owner = cluster.instanceId
  }

  async onModuleInit(): Promise<void> {
    // 权限变化事件（本进程的路由当场，别的进程撤权经协同的轮询转成本进程的通知）→ 重判在跑的任务，失权的叫停
    this.stopRevocation = this.revocation.onRevoked(() => this.authorities.reconcileLive())
    this.stopCancelHandler = await this.cluster.bus.handle(APPS_CANCEL_TASK, ({ taskId }) => ({ aborted: this.abortTask(taskId, 'canceled') }))
    const first = setTimeout(() => this.tick(), this.options.firstSweepMs)
    const timer = setInterval(() => this.tick(), this.options.sweepIntervalMs)
    first.unref()
    timer.unref()
    this.timers = [first, timer]
  }

  /**
   * 退出。**放在 `onModuleDestroy`，不放 `beforeApplicationShutdown`**：协同在后者关房间、落库、关 Redis 扩展，而断开这里的 direct connection（落库、卸载）要它们还开着。
   * Nest 走完全部模块的 `onModuleDestroy` 才进下一阶段，所以这里一定先跑完。
   */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    this.stopRevocation?.()
    this.stopRevocation = undefined
    await this.stopCancelHandler?.()
    this.stopCancelHandler = undefined
    const entries = [...this.runningTasks.values()]
    for (const entry of entries) entry.controller.abort('shutdown')
    // 收不了尾的（比如正在取一个大产物）不能挡住退出：租约到期后由别的进程接手
    await Promise.race([Promise.allSettled(entries.map((entry) => entry.done)), sleep(this.options.shutdownTimeoutMs, undefined, { ref: false })])
  }

  private tick(): void {
    if (this.sweeping || this.stopping) return
    this.sweeping = true
    void this.sweep()
      .catch((err: unknown) => console.warn('[apps] 任务对账失败（下次再试）', err))
      .finally(() => {
        this.sweeping = false
      })
  }

  /** 抢租约并执行；抢不到（别人已接手 / 已结束）或正在退出返回 false，正在退出的留给下一个进程的对账 */
  async runTask(taskId: string): Promise<boolean> {
    if (this.runningTasks.has(taskId)) return true
    if (this.stopping || !(await this.tasks.claim(taskId, this.owner, this.options.leaseMs))) return false
    const row = await this.tasks.get(taskId)
    if (!row) return false
    if (this.stopping) {
      await this.tasks.release(taskId, this.owner)
      return false
    }
    this.start(row)
    return true
  }

  /** 本进程在跑它就停下 */
  abortTask(taskId: string, reason: StopReason): boolean {
    const entry = this.runningTasks.get(taskId)
    if (!entry) return false
    entry.controller.abort(reason)
    return true
  }

  /** 对账一次：接手租约过期的进行中任务 */
  async sweep(): Promise<void> {
    for (const row of await this.tasks.reclaimable(SWEEP_BATCH)) {
      if (this.stopping) return
      if (this.runningTasks.has(row.id)) continue
      if (await this.runTask(row.id)) console.info(`[apps] 接手任务 ${row.id}（${row.status}${row.handle ? '，有续查句柄' : ''}）`)
    }
  }

  /** 本进程在跑的任务 id（测试、排查用） */
  running(): string[] {
    return [...this.runningTasks.keys()]
  }

  /** 这张画布进行中的任务（线上形状） */
  async viewsOf(rows: readonly AppTaskRow[]) {
    return this.tasks.views(rows, (appId) => this.service.get(appId)?.title)
  }

  private broadcast(flowId: string): Promise<void> {
    const previous = this.broadcastChains.get(flowId) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        const document = this.collab.hocuspocus.documents.get(roomOf(flowId))
        if (!document) return
        const views = await this.viewsOf(await this.tasks.listActive(flowId))
        document.broadcastStateless(formatAppTasksMessage(flowId, views))
      })
      .catch((err: unknown) => console.warn(`[apps] 推送画布 ${flowId} 的任务列表失败`, err))
    this.broadcastChains.set(flowId, next)
    void next.then(() => {
      if (this.broadcastChains.get(flowId) === next) this.broadcastChains.delete(flowId)
    })
    return next
  }

  /**
   * 推送一次这张画布的任务列表。排队中的任务被取消时用：它没有执行方替它推送，别的协作者的列表里它会一直挂着（排队中的任务在文档里没有痕迹，前端没法拿文档对账）。
   * 本进程没有这个房间就短暂开一条 direct connection（经 Redis 扩展转发给持有房间的副本），推完断开。路由不等断开：Redis 扩展散场要多等 1 秒。
   */
  async pushTasks(flowId: string): Promise<void> {
    const push = async () => {
      const hocuspocus = this.collab.hocuspocus
      const room = roomOf(flowId)
      if (hocuspocus.documents.get(room)) return this.broadcast(flowId)
      const connection = await hocuspocus.openDirectConnection(room, { apps: { push: true } })
      try {
        await this.broadcast(flowId)
      } finally {
        await connection.disconnect().catch((err: unknown) => console.warn(`[apps] 推送画布 ${flowId} 后断开连接失败`, err))
      }
    }
    await Promise.race([push().catch((err: unknown) => console.warn(`[apps] 推送画布 ${flowId} 的任务列表失败`, err)), sleep(PUSH_WAIT_MS, undefined, { ref: false })])
  }

  private start(row: AppTaskRow): void {
    const controller = new AbortController()
    const done = this.runClaimed(row, controller)
      .catch((err: unknown) => console.error(`[apps] 任务 ${row.id} 收尾失败`, err))
      .finally(() => {
        if (this.runningTasks.get(row.id)?.controller === controller) this.runningTasks.delete(row.id)
      })
    this.runningTasks.set(row.id, { controller, done })
  }

  private async runClaimed(row: AppTaskRow, controller: AbortController): Promise<void> {
    const { owner, tasks, service, storage, collab } = this
    const signal = controller.signal
    const reason = (): StopReason | null => (signal.aborted ? (signal.reason as StopReason) : null)
    const room = roomOf(row.flowId)
    let handle = handleOf(row)
    let connection: Awaited<ReturnType<CollabServer['hocuspocus']['openDirectConnection']>> | null = null
    let authority: TaskAuthority | null = null
    /** 发起人失权的原因（`revoked` 时写进任务行） */
    let revokedReason = ''

    /** 在房间里写这个节点；条件不满足就跳过（只打日志） */
    const writeNode = async (label: string, fn: (ctx: FlowOpContext, runtime: Y.Map<unknown> | undefined) => void) => {
      const doc = connection?.document
      if (!doc || !authority) return
      try {
        // 凭发起人写：失权的在这里被拦下（并叫停任务）
        await authority.authorize('flow:write')
        const locked = collab.quotaLocked(room)
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

    const renew = setInterval(
      () => {
        void tasks
          .renew(row.id, owner, this.options.leaseMs)
          .then(async (ok) => {
            if (ok || signal.aborted) return
            const current = await tasks.get(row.id)
            controller.abort(current?.status === 'canceled' ? 'canceled' : 'lost')
          })
          .catch((err: unknown) => console.warn(`[apps] 任务 ${row.id} 续租失败（下次再试）`, err))
        // 顺带按发起人判一次：失权的当场叫停（判权里经 stop 回调）
        authority?.authorize('flow:read').catch((err: unknown) => {
          if (!isTaskRevoked(err)) console.warn(`[apps] 任务 ${row.id} 续租时判权失败（下次再试）`, err)
        })
      },
      Math.max(1_000, Math.floor(this.options.leaseMs / 3)),
    )
    renew.unref()

    try {
      // 按发起人签执行身份：此刻就进不了画布 → 抛出，任务记失败，不开房间、不调上游
      authority = await this.authorities.issue({
        taskId: row.id,
        flowId: row.flowId,
        userId: row.userId,
        stop(why) {
          revokedReason = why
          controller.abort('revoked')
        },
      })
      connection = await collab.hocuspocus.openDirectConnection(room, { apps: { taskId: row.id, userId: row.userId } })
      const wasRunning = row.status === 'running'
      const startedAt = await tasks.start(row, owner)
      await writeNode('开始', (ctx, runtime) => {
        // 节点上另有一个在跑的任务（不该发生：同一节点只许一个）就不抢
        const other = runtime?.get('taskId')
        if (runtime?.get('status') === 'processing' && typeof other === 'string' && other !== row.id) return
        writeNodeFields(ctx, row.nodeId, 'runtime', { set: { status: 'processing', taskId: row.id }, remove: ['error'] })
      })
      void this.broadcast(row.flowId)

      const onProgress = (progress: AppTaskProgress) => {
        void tasks
          .saveProgress(row.id, owner, progress)
          .then(() => this.broadcast(row.flowId))
          .catch((err: unknown) => console.warn(`[apps] 任务 ${row.id} 的进度没存上`, err))
      }

      let result: AppResult
      if (handle) {
        result = await service.resumeApp(row.appId, handle, { signal, startedAt: startedAt.getTime(), userId: row.userId, onProgress })
      } else if (wasRunning) {
        // 同步上游调到一半、进程没了：结果拿不回来，也不重复提交（会重复扣费）
        throw new AppError('aborted', '执行中断（服务重启），请重新生成')
      } else {
        const app = service.get(row.appId)
        if (!app) throw new AppError('not_found', `应用 ${row.appId} 已经不在配置里了`)
        await authority.authorize('flow:read')
        const params = await inlineFlowAssets(storage, row.flowId, app, paramsOf(row), signal)
        result = await service.executeApp(row.appId, params, {
          signal,
          startedAt: startedAt.getTime(),
          userId: row.userId,
          onProgress,
          onSubmitted: async (next) => {
            handle = next
            await tasks.saveHandle(row.id, owner, next)
          },
        })
      }

      // 产物存成这张画布的资源 = 往画布里写：凭发起人判
      await authority.authorize('flow:write')
      const persisted = await persistFlowOutputs(storage, { flowId: row.flowId, userId: row.userId, result })
      const outputs = persisted.outputs.map(outputView)
      if (!(await tasks.finish(row.id, owner, { status: 'succeeded', outputs }))) return
      const category = service.get(row.appId)?.category
      const output = outputs.find((item) => item.kind === category && item.url)
      // 文字产物：第一段非空的正文（思考在 `meta` 里，只留在任务表，不进节点）
      const text = category === 'text' ? outputs.find((item) => item.kind === 'text' && item.text?.trim())?.text : undefined
      // 视频节点画的是预览图：产物里有图（尾帧）就当预览图
      const poster = category === 'video' ? outputs.find((item) => item.kind === 'image' && item.url)?.url : undefined
      await writeNode('完成', (ctx, runtime) => {
        if (!ownsNode(runtime)) return
        if (text !== undefined && appendGeneratedText(ctx, row.nodeId, text)) {
          writeNodeFields(ctx, row.nodeId, 'runtime', { set: { status: 'completed' }, remove: ['error'] })
        } else if (output?.url) {
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
        if (handle) await service.cancelUpstream(row.appId, handle)
        await writeNode('取消', (ctx, runtime) => {
          if (ownsNode(runtime)) writeNodeFields(ctx, row.nodeId, 'runtime', { set: { status: 'idle' }, remove: ['error'] })
        })
      } else if (stopped === 'revoked') {
        // 发起人无权了：撤上游、任务记失败；节点不碰（无权写）
        if (handle) await service.cancelUpstream(row.appId, handle)
        await tasks.finish(row.id, owner, { status: 'failed', error: revokedReason })
      } else if (stopped === 'shutdown') {
        await tasks.release(row.id, owner).catch((error: unknown) => console.warn(`[apps] 任务 ${row.id} 放租约失败`, error))
      } else if (stopped === null) {
        const known = err instanceof AppError || isTaskRevoked(err)
        const message = known ? err.message : `执行出错：${err instanceof Error ? err.message : String(err)}`
        if (!known) console.error(`[apps] 任务 ${row.id} 执行出错`, err)
        if (await tasks.finish(row.id, owner, { status: 'failed', error: message })) {
          await writeNode('失败', (ctx, runtime) => {
            if (ownsNode(runtime)) writeNodeFields(ctx, row.nodeId, 'runtime', { set: { status: 'error', error: message } })
          })
        }
      }
    } finally {
      clearInterval(renew)
      authority?.release()
      await this.broadcast(row.flowId)
      // 断开时 Hocuspocus 立刻跑一次 store（不等防抖），没有别的连接就卸载房间 —— 写回在这里确定落库
      await connection?.disconnect().catch((err: unknown) => console.warn(`[apps] 任务 ${row.id} 断开画布连接失败`, err))
    }
  }
}

function outputView({ data, ...rest }: AppOutput): AppOutputView {
  // 存不进资源的字节产物不进任务表（几十 MB 的 base64 没有意义）；画布节点只认地址
  return data ? { ...rest, meta: { ...rest.meta, dropped: 'bytes' } } : rest
}
