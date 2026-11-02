import { defineEntity, p, type InferEntity } from '@mikro-orm/core'
import { createdAtColumn, idColumn, updatedAtColumn } from './columns.js'

/**
 * 用户档案。**这张表是所有模块的公共外键目标**：模块包之间不该为了一个外键互相依赖，所以实体定义放在这里，
 * 所有模块引用的是同一个实体对象；登录、会话、身份绑定的表归 `@learning/session`。
 * 档案字段来自**主身份**那个提供方（OIDC 的 id_token / GitHub 的 /user）。
 *
 * `(issuer, subject)` 仍然是唯一键，但它的含义是**主身份的冗余副本** —— 真正的绑定清单在 `UserIdentity` 里，一个人可以绑多条。
 * 留着这两列是因为默认头像的种子按 (issuer, subject) 算（换主身份不该换掉那张图），老数据也靠它们领养。
 */
export const User = defineEntity({
  name: 'User',
  properties: {
    id: idColumn(),
    issuer: p.text(),
    subject: p.text(),
    username: p.text().strictNullable(),
    email: p.text().strictNullable(),
    name: p.text().strictNullable(),
    avatarUrl: p.text().strictNullable(),
    /** 提供方给的 realm/client 角色，存成 JSON 字符串（不用数据库的数组 / JSON 类型，两边统一） */
    roles: p.text().default('[]'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    lastLoginAt: p.datetime().strictNullable(),
  },
  uniques: [{ properties: ['issuer', 'subject'] }],
})
export type User = InferEntity<typeof User>
