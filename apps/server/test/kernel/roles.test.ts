import { describe, expect, it } from 'vitest'
import { ALL_ROLES, assertRolesSupported, isAllRoles, parseRoles } from '../../kernel/roles.ts'

describe('parseRoles：SERVER_ROLES 的解析', () => {
  it('没配 / 空串 / 只有分隔符 → 全部角色', () => {
    for (const raw of [undefined, '', '  ', ',,']) {
      const roles = parseRoles(raw)
      expect([...roles]).toEqual([...ALL_ROLES])
      expect(isAllRoles(roles)).toBe(true)
    }
  })

  it('逗号或空白分隔，不分大小写，重复合并', () => {
    expect([...parseRoles('Web, collab web')]).toEqual(['web', 'collab'])
    expect(isAllRoles(parseRoles('web,collab'))).toBe(false)
  })

  it('认不出的角色名直接抛，不猜', () => {
    expect(() => parseRoles('web,worker')).toThrow(/认不出的角色 "worker"/)
  })
})

describe('assertRolesSupported：角色集和副本模式的搭配', () => {
  it('全部角色在任何模式下都成立', () => {
    expect(() => assertRolesSupported(parseRoles(undefined), { clustered: false })).not.toThrow()
    expect(() => assertRolesSupported(parseRoles(undefined), { clustered: true })).not.toThrow()
  })

  it('单副本（没有 Redis）下拆角色 → 拒绝，并指出原因', () => {
    expect(() => assertRolesSupported(parseRoles('collab'), { clustered: false })).toThrow(/CLUSTER_MODE 是 single/)
  })

  it('多副本下拆角色 → 第 1 期仍拒绝，并指向第 4 期', () => {
    expect(() => assertRolesSupported(parseRoles('web'), { clustered: true })).toThrow(/第 4 期/)
  })
})
