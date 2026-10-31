/**
 * 进程角色（REQ-MODULES，docs/28 §3.2）：同一份产物按 `SERVER_ROLES` 启动成不同的进程。
 *
 * - `web`：REST、静态前端、登录守卫、对象存储；
 * - `collab`：协同 WebSocket；
 * - `agent`：agent 执行（含一个不对外的协同实例）。
 *
 * 不配 = 全部角色一个进程，也就是改造前的单进程形态。这里只有纯解析，不读 `process.env`（那在 `config.ts`）。
 */
export const ALL_ROLES = ['web', 'collab', 'agent'] as const
export type ServerRole = (typeof ALL_ROLES)[number]

function isRole(value: string): value is ServerRole {
  return (ALL_ROLES as readonly string[]).includes(value)
}

/** `SERVER_ROLES="web,collab"` → 角色集。空 / 没配 = 全部；认不出的名字直接抛，不猜 */
export function parseRoles(raw: string | undefined): ReadonlySet<ServerRole> {
  const names = (raw ?? '')
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  if (names.length === 0) return new Set(ALL_ROLES)

  const roles = new Set<ServerRole>()
  for (const name of names) {
    if (!isRole(name)) {
      throw new Error(`SERVER_ROLES 里有认不出的角色 "${name}"（可选：${ALL_ROLES.join(' / ')}）`)
    }
    roles.add(name)
  }
  return roles
}

/** 这个角色集是不是「全部角色」（= 单进程形态） */
export function isAllRoles(roles: ReadonlySet<ServerRole>): boolean {
  return ALL_ROLES.every((role) => roles.has(role))
}

/**
 * 角色集和副本模式的搭配是否成立。
 *
 * **单副本（没有 Redis）下角色不能拆开**：两个进程各持一份 Y.Doc，就回到 docs/14 §2 的丢数据场景 ——
 * 不管是不是生产，一律拒绝。
 */
export function assertRolesSupported(roles: ReadonlySet<ServerRole>, options: { clustered: boolean }): void {
  if (isAllRoles(roles)) return
  if (!options.clustered) {
    throw new Error(
      `[roles] SERVER_ROLES=${[...roles].join(',')} 但 CLUSTER_MODE 是 single：没有 Redis 时各角色各持一份画布内容，不能拆开部署（docs/28 §3.4.2）`,
    )
  }
  // 第 1 期：路由仍由 app.ts 静态挂、模块间还有直接调用，拆开起的进程会在运行时碰到不在本进程的东西。
  // 等第 4 期路由随模块走、直接调用改成总线之后再放开（docs/28 §7）
  throw new Error(
    `[roles] SERVER_ROLES=${[...roles].join(',')}：按角色拆分部署要等 REQ-MODULES 第 4 期（docs/28 §7），现在只能全部角色一个进程`,
  )
}
