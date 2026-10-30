import { defineEntity, p, type InferEntity } from '@mikro-orm/core'
import { User } from './auth.ts'
import { createdAtColumn, idColumn, updatedAtColumn } from './columns.ts'

// 项目、画布与协同相关的实体（REQ-CANVAS / REQ-COLLAB）。
// 写实体的规矩见 ./columns.ts 的头注释。
//
// 只定义了「拥有外键的那一侧」（多对一），没有反向的一对多集合：查询都从拥有外键的那张表出发
// （「我参与的项目」= 查 ProjectMember），用不上反向集合；而 defineEntity 的类型推断遇到
// 互相引用的两个实体会退化成 any，不值得为用不上的东西付这个代价。

/**
 * 画布的容器与权限边界：成员身份决定画布的访问权。
 * 软删只是过滤条件 —— 不清理、不物理删除、不提供恢复入口。
 */
export const Project = defineEntity({
  name: 'Project',
  properties: {
    id: idColumn(),
    name: p.text(),
    description: p.text().strictNullable(),
    /**
     * team | personal —— personal 是每人一个的私人空间，里面的画布不走协同（REQ-SOLO）。
     * 画布的 mode 由它派生，不在 Flow 上另存一份：存两处必然漂移
     */
    kind: p.text().default('team'),
    /**
     * 个人空间的归属者；团队项目为 null。
     * unique 就是「一人最多一个个人空间」这条约束本身 —— 不靠代码去保证
     */
    personalOwner: () => p.manyToOne(User).nullable().unique().deleteRule('cascade'),
    createdBy: () => p.manyToOne(User).deleteRule('cascade'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: p.datetime().strictNullable(),
  },
  indexes: [{ properties: ['deletedAt'] }],
})
export type Project = InferEntity<typeof Project>

/**
 * 项目成员。一个用户在一个项目里最多一条。
 * 创建者的 admin 行是真实写入的，不靠 Project.createdBy 隐式推断。
 */
export const ProjectMember = defineEntity({
  name: 'ProjectMember',
  properties: {
    id: idColumn(),
    project: () => p.manyToOne(Project).deleteRule('cascade'),
    user: () => p.manyToOne(User).deleteRule('cascade'),
    /** admin | member */
    role: p.text().default('member'),
    /** 通过哪个用户的邀请进来的；创建者为 null。只是一个 id，不建外键 */
    invitedById: p.text().strictNullable(),
    joinedAt: p.datetime().onCreate(() => new Date()),
  },
  uniques: [{ properties: ['project', 'user'] }],
  indexes: [{ properties: ['user'] }],
})
export type ProjectMember = InferEntity<typeof ProjectMember>

/**
 * 分享链接 —— 加入项目的唯一入口。**一个项目只有一条**（project 唯一）。
 * token 明文存：它本身就是要发给别人的凭据。
 * 不限使用次数，唯一的闸是 expiresAt；重置就是原地换一个 token，旧链接随即查不到。
 */
export const ProjectInvite = defineEntity({
  name: 'ProjectInvite',
  properties: {
    id: idColumn(),
    project: () => p.manyToOne(Project).unique().deleteRule('cascade'),
    token: p.text().unique(),
    /** 接受后获得的角色，本期恒为 member */
    role: p.text().default('member'),
    /** 只是一个 id，不建外键 */
    createdById: p.text(),
    createdAt: createdAtColumn(),
    expiresAt: p.datetime(),
  },
})
export type ProjectInvite = InferEntity<typeof ProjectInvite>

/**
 * 一张画布。内容的事实源是 ydoc（Yjs 状态），graph 是服务端从它派生出来的只读投影。
 *
 * `ydoc` 和 `graph` 是 **lazy** 的：默认查询不取它们（一张画布的 ydoc 可以有 20MB），
 * 要用的地方显式 `populate: ['ydoc']` / `['graph']`。列表接口因此不可能把它们带出去。
 */
export const Flow = defineEntity({
  name: 'Flow',
  properties: {
    id: idColumn(),
    project: () => p.manyToOne(Project).deleteRule('cascade'),
    name: p.text(),
    description: p.text().strictNullable(),
    /** draft | published | archived */
    status: p.text().default('draft'),
    /** 标签，JSON 字符串数组（不用数据库的数组类型，两边统一用字符串） */
    tags: p.text().default('[]'),
    thumbnail: p.text().strictNullable(),
    /**
     * **画布内容的唯一事实源**：Yjs 文档状态（`Y.encodeStateAsUpdate` 的二进制）。
     * 为空表示还没被 Yjs 接管过，此时从下面的 graph JSON 现场构建（老数据的迁移入口）。
     */
    ydoc: p.blob().strictNullable().lazy(),
    /**
     * ydoc 的**只读投影**，服务端在写状态时派生出来。
     * 列表页、缩略图、将来的只读预览走它，编辑器不再读它（内容从 WebSocket 来）。
     */
    graph: p.text().default('{}').lazy(),
    /** 冗余统计，列表直接展示；和 graph 一起派生 */
    nodeCount: p.integer().default(0),
    edgeCount: p.integer().default(0),
    /**
     * 服务端写入 ydoc 的次数。CRDT 不需要乐观锁，这里是单调的写计数 ——
     * 落库时拿它做 CAS（`where revision = 读到的值`），防多副本互相整段覆盖
     */
    revision: p.integer().default(0),
    /** 创建者，仅用于展示，不参与鉴权（鉴权看项目成员身份）。只是一个 id，不建外键 */
    createdById: p.text(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: p.datetime().strictNullable(),
  },
  indexes: [{ properties: ['project', 'deletedAt', 'updatedAt'] }],
})
export type Flow = InferEntity<typeof Flow>

/**
 * 画布上**属于某个人**的状态：视口（看哪儿、放多大）、以及以后的面板开合、
 * 个人偏好…… 这些是「我怎么看这张画布」，不是画布内容 ——
 * 所以不进 ydoc，一人一份，互不影响。
 *
 * 按 key 分区存 JSON 字符串：**加一种要存的东西 = 加一个 key，不用改表**。
 * key 的合法集合与各自的校验在 apps/server/store/flow-types.ts 的
 * FLOW_USER_STATE_PARSERS 里，不认识的 key 一律 400，别当成任意 KV 用。
 */
export const FlowUserState = defineEntity({
  name: 'FlowUserState',
  properties: {
    id: idColumn(),
    flow: () => p.manyToOne(Flow).deleteRule('cascade'),
    user: () => p.manyToOne(User).deleteRule('cascade'),
    /** 状态分区名，例如 viewport */
    key: p.text(),
    /** 该分区的值，JSON 字符串 */
    value: p.text(),
    updatedAt: updatedAtColumn(),
  },
  uniques: [{ properties: ['flow', 'user', 'key'] }],
  indexes: [{ properties: ['user'] }],
})
export type FlowUserState = InferEntity<typeof FlowUserState>

/**
 * 画布资源的上传记录：**哪个对象键是在哪张画布上传的**。上传接口（`routes/assets.ts`）在对象写进 S3 之后、
 * 回包之前写一行（分片上传在 complete 时写）。
 *
 * 对象键本身看不出归属（所有素材进同一个 `assets/` 目录，`storage/keys.ts`），所以凡是「客户端递来一个键，
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
    /** 对象键（`storage/keys.ts` 拼出来的），全局唯一 */
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
