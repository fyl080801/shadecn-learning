import { defineEntity, p, type InferEntity } from '@mikro-orm/core'
import { createdAtColumn, idColumn, updatedAtColumn } from '@shadecn/server-kit/db'

// 应用执行模块的持久化（REQ-APPS，docs/29 §3.10）：画布生成任务。写实体的规矩见 `@shadecn/server-kit/db` 的头注释；读写都在 ./tasks.ts。

/**
 * 一个画布生成任务：一次「在某张画布的某个节点上用某个应用生成」。生命周期的**权威**在这张表 ——
 * 节点上的 `runtime.status` 只是给协作者看的投影，进度只走推送。
 *
 * - **画布 / 用户 / 节点都只是 id，不建外键**：任务是执行记录，画布删了、人走了，执行副本照样要能把它收尾（并据此不再写回）；
 *   节点在 Y.Doc 里，不在库里。
 * - **租约**（`leaseOwner` / `leaseUntil`）：哪个执行副本在跑它、到什么时候。接手 = 原子地写上自己（`tasks.ts` 的 `claim`），
 *   执行期间续租；租约过期的进行中任务由别的副本（或重启后的自己）接手。
 * - **续查句柄**（`handle`）：任务型上游建好任务后存下来，接手的副本拿它接着查，不重新提交（不重复扣费）。
 * - JSON 列（`params` / `progress` / `handle` / `outputs`）都是字符串（`db.ts` 只用五种类型）。
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
    /** 定下来的模型（多模型应用、单模型应用都记；不要模型的操作为 null） */
    model: p.text().strictNullable(),
    /** 调用方给的参数（JSON 对象字符串，参考图还是地址 —— 换字节在执行时做） */
    params: p.text(),
    /** `queued` / `running` / `succeeded` / `failed` / `canceled`（`@shadecn/shared/apps` 的 `AppTaskStatus`） */
    status: p.text(),
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
    /** 第一次被执行副本接手的时刻：时限从它算，续查不重置 */
    startedAt: p.datetime().strictNullable(),
    finishedAt: p.datetime().strictNullable(),
    updatedAt: updatedAtColumn(),
  },
  indexes: [
    // 画布的进行中任务、同一节点只能有一个
    { properties: ['flowId', 'status'] },
    // 对账：进行中且租约过期
    { properties: ['status', 'leaseUntil'] },
  ],
})
export type AppTask = InferEntity<typeof AppTask>
