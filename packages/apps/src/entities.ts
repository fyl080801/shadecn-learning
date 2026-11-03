import { createdAtColumn, idColumn, updatedAtColumn } from '@learning/data-access'
import { defineEntity, type InferEntity, p } from '@mikro-orm/core'

/**
 * 一个画布生成任务（docs/29 §3.10）：一次「在某张画布的某个节点上用某个应用生成」。生命周期的**权威**在这张表 ——
 * 节点上的 `runtime.status` 只是给协作者看的投影，进度只走推送。读写都在 `tasks.ts`。和 `@shadecn/mod-apps` 是两份定义，互不同步。
 *
 * - **画布 / 用户 / 节点都只是 id，不建外键**：任务是执行记录，画布删了、人走了，执行方照样要能把它收尾（并据此不再写回）；节点在 Y.Doc 里，不在库里。
 * - **`activeKey`**：同一节点同时只许一个进行中的任务，靠它的唯一约束判输赢。进行中 = `<flowId>/<nodeId>`，结束就清成 null（两种库的唯一约束都放过多个 NULL）。
 *   先查后插挡不住并发：两个请求都查到没有，都插进去。
 * - **租约**（`leaseOwner` / `leaseUntil`）：哪个进程在跑它、到什么时候。接手 = 原子地写上自己，执行期间续租；过期的进行中任务由别的进程（或重启后的自己）接手。
 * - **续查句柄**（`handle`）：任务型上游建好任务后存下来，接手方拿它接着查，不重新提交（不重复扣费）。
 * - JSON 列（`params` / `progress` / `handle` / `outputs`）都是字符串（`@learning/data-access` 只用五种类型）。
 */
export const AppTask = defineEntity({
  name: 'AppTask',
  properties: {
    id: idColumn(),
    flowId: p.text(),
    nodeId: p.text(),
    /** 发起人 */
    userId: p.text(),
    appId: p.text(),
    /** 这个应用的模型（提交时记下；不要模型的操作为 null） */
    model: p.text().strictNullable(),
    /** 调用方给的参数（JSON 对象字符串，参考图还是地址，换字节在执行时做） */
    params: p.text(),
    /** `queued` / `running` / `succeeded` / `failed` / `canceled`（`@learning/contracts/apps` 的 `AppTaskStatus`） */
    status: p.text(),
    /** 进行中才有，见上 */
    activeKey: p.text().strictNullable().unique(),
    /** 最近一次进度，JSON：`{ status, ratio? }` */
    progress: p.text().strictNullable(),
    /** 续查句柄，JSON：`{ upstreamId, state? }`；同步上游没有 */
    handle: p.text().strictNullable(),
    /** 失败原因（给人看的那句） */
    error: p.text().strictNullable(),
    /** 产物，JSON：`AppOutputView[]`（存进画布资源之后的地址，不含字节） */
    outputs: p.text().strictNullable(),
    leaseOwner: p.text().strictNullable(),
    leaseUntil: p.datetime().strictNullable(),
    createdAt: createdAtColumn(),
    /** 第一次被接手执行的时刻：时限从它算，续查不重置 */
    startedAt: p.datetime().strictNullable(),
    finishedAt: p.datetime().strictNullable(),
    updatedAt: updatedAtColumn(),
  },
  indexes: [
    // 画布的进行中任务
    { properties: ['flowId', 'status'] },
    // 对账：进行中且租约过期
    { properties: ['status', 'leaseUntil'] },
  ],
})
export type AppTask = InferEntity<typeof AppTask>
