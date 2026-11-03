import { Flow } from '@learning/canvas'
import { createdAtColumn, idColumn } from '@learning/data-access'
import { defineEntity, p, type InferEntity } from '@mikro-orm/core'

// 对象存储模块的表。写实体的规矩见 `@learning/data-access` 的 `columns.ts` 头注释。
// **和 `@shadecn/mod-storage` 是两份定义**（docs/30 §1）：现在列对列一致，以后各改各的。

/**
 * 画布资源的上传记录：**哪个对象键是在哪张画布上传的**。对象写进 S3 之后、回包之前写一行（分片上传在 complete 时写）。
 *
 * 对象键看不出归属（所有素材进同一个 `assets/` 目录，见 `keys.ts`），所以「客户端递来一个键，要确认它属于这张画布」都查这里。
 * `contentType` 以服务端看到的为准（单次上传是表单里文件的类型，分片上传是 S3 拼完后 HEAD 回来的）。
 * 画布软删时记录留着，真删时跟着级联。`key` 的唯一约束就是「一个键只归一张画布」这条约束本身。
 */
export const FlowAsset = defineEntity({
  name: 'FlowAsset',
  properties: {
    id: idColumn(),
    key: p.text().unique(),
    flow: () => p.manyToOne(Flow).deleteRule('cascade'),
    contentType: p.text(),
    /** 上传的人，只做审计，不建外键 */
    createdById: p.text(),
    createdAt: createdAtColumn(),
  },
  indexes: [{ properties: ['flow'] }],
})
export type FlowAsset = InferEntity<typeof FlowAsset>
