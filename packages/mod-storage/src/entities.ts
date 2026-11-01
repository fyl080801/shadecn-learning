import { defineEntity, p, type InferEntity } from '@mikro-orm/core'
import { Flow } from '@shadecn/mod-canvas/entities'
import { createdAtColumn, idColumn } from '@shadecn/server-kit/db'

// 对象存储模块的表（docs/28 §3.1.2）。写实体的规矩见 `@shadecn/server-kit/db` 的头注释。

/**
 * 画布资源的上传记录：**哪个对象键是在哪张画布上传的**。上传接口（`@shadecn/mod-storage/routes`）在对象写进 S3 之后、
 * 回包之前写一行（分片上传在 complete 时写）。
 *
 * 对象键本身看不出归属（所有素材进同一个 `assets/` 目录，`@shadecn/mod-storage/keys`），所以凡是「客户端递来一个键，
 * 要确认它属于这张画布」的地方都查这里 —— 现在是 agent 消息的附件（docs/20 §3.10.12），
 * 以后私有访问判权（docs/25 §3.3）也从它出发。
 *
 * `contentType` 以服务端看到的为准（单次上传是表单里文件的类型，分片上传是 S3 拼完后 HEAD 回来的），
 * 引用它的地方不再信客户端的声明。画布真删时跟着级联（画布是软删，软删期间记录留着）。
 */
export const FlowAsset = defineEntity({
  name: 'FlowAsset',
  properties: {
    id: idColumn(),
    /** 对象键（`@shadecn/mod-storage/keys` 拼出来的），全局唯一 */
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
