import { sharedMap, stringCodec } from '../cluster/index.ts'
import type { CollabIdentity } from '../auth/ws.ts'

/**
 * clientID 的归属登记：`<房间>:<clientID>` → 首次发布它的 socketId。
 *
 * awareness 更新按条目自带的 clientID + clock 应用 —— 不登记的话，任何成员都能
 * 构造带队友 clientID、clock 抬高的条目，把对方的光标钉在任意位置、逐帧覆写
 * 对方的拖拽几何，而对方自己后续的真实更新因为 clock 偏低会一直被忽略。
 * 将来把占用仲裁接回 draggable/selectable 时，这个洞会直接升级成编辑权劫持。
 *
 * 规则很短：**谁先发布一个 clientID，这个 clientID 就归谁的 socket**。
 * clientID 是客户端随机挑的 32 位数，抢注别人「将来的」号码无从谈起；
 * 断线重连换了 socket 的话，旧 socket 的登记在 `releaseSocket` 里清掉，
 * 新 socket 重新认领同一个 clientID（provider 重连不换 Y.Doc，号码不变）。
 *
 * **多副本下这张表必须共享**：两个人连在不同实例上时，各自实例只看得见自己那半，
 * 冒名者只要连到另一个实例就绕过了登记。所以认领走 `claim()`（Redis 的 `SET NX`，
 * 判断加写入是一个原子动作），登记里的 socketId 也带上实例前缀 ——
 * socketId 只在单个进程里唯一，不加前缀两个实例会撞号，正主反而被当成冒用。
 */
const claims = sharedMap<string>('awareness-claims', stringCodec)

/**
 * 登记的存活时间。
 *
 * 正常释放走 `releaseSocket`（断连时）。TTL 是给「实例崩了没来得及释放」兜底的：
 * 没有它，那个 clientID 会永远归一个已经不存在的 socket，本人重连也发不出 awareness。
 * 取值远大于一次重连所需的时间，不然会把还活着的登记冲掉。
 */
const CLAIM_TTL = 10 * 60_000

/**
 * 认领结果的本地缓存。
 *
 * `beforeHandleAwareness` 是**每帧**都跑的热路径，不能每帧一次 Redis 往返。
 * 一个 clientID 只有**第一次**出现时走网络，之后全在本地判断 ——
 * 归属一旦定下就不会变（要变只能先断连释放，那时缓存也一并清掉）。
 */
const localOwners = new Map<string, string>()

function claimKey(room: string, clientId: number) {
  return `${room}:${clientId}`
}

/**
 * 把 `states` 里**不属于这条连接**的条目就地删掉，返回删了几条。
 *
 * `states` 是 Hocuspocus 从这一条消息里解出来的条目集合（可变 Map），
 * 删掉的条目不会进文档的 awareness，也不会被广播。
 *
 * Redis 不可用时**放行**：这是一道防冒名的护栏，不是访问控制那道门
 * （那道在 `onConnect` 已经把过了），为它把所有人的在场状态卡死不划算。
 */
export async function dropForeignClients(
  room: string,
  socketId: string,
  states: Map<number, Record<string, unknown>>,
): Promise<number> {
  let dropped = 0

  for (const clientId of [...states.keys()]) {
    const key = claimKey(room, clientId)
    const cached = localOwners.get(key)

    if (cached === undefined) {
      // 第一次见这个号：试着认领。抢到就是我们的，没抢到要问清楚是谁的
      const won = await claims.claim(key, socketId, CLAIM_TTL).catch(() => true)
      const owner = won ? socketId : ((await claims.get(key).catch(() => socketId)) ?? socketId)
      localOwners.set(key, owner)
      if (owner === socketId) continue
      states.delete(clientId)
      dropped += 1
      continue
    }

    if (cached !== socketId) {
      states.delete(clientId)
      dropped += 1
    }
  }

  if (dropped > 0) {
    console.warn(`[collab] ${room} 丢弃了 ${dropped} 条冒用他人 clientID 的 awareness 更新`)
  }
  return dropped
}

/** 一条连接断开：它认领过的 clientID 全部释放，重连的新 socket 才能接着用 */
export async function releaseSocket(room: string, socketId: string): Promise<void> {
  const prefix = `${room}:`

  for (const [key, owner] of [...localOwners]) {
    if (key.startsWith(prefix) && owner === socketId) localOwners.delete(key)
  }

  // 冷路径（断连时），扫一遍这个房间的登记，只删自己认领的那些。
  // 房间里的登记条数 = 在线人数，量级很小
  const entries = await claims.entries(prefix).catch(() => [])
  await Promise.all(
    entries.filter(([, owner]) => owner === socketId).map(([key]) => claims.delete(key)),
  ).catch(() => undefined)
}

/** 房间散场：整张登记表作废 */
export async function forgetClaims(room: string): Promise<void> {
  const prefix = `${room}:`
  for (const key of [...localOwners.keys()]) {
    if (key.startsWith(prefix)) localOwners.delete(key)
  }
  await claims.deleteByPrefix(prefix).catch(() => undefined)
}

/**
 * 把 awareness 里客户端自报的身份换成服务端认定的那一份。
 *
 * awareness 的内容本来完全由客户端自己写、服务端只负责转发 —— 也就是说同一个房间里的人
 * 可以把自己的 `user` 改成别人的名字和头像，在场头像栏和光标标签就会显示成那个人。
 * 光标位置、选中了谁这些**可以**随便报（报错了也只是画面不准），
 * 但「你是谁」必须由认过 cookie 的服务端说了算。
 *
 * 就地改传进来的 `states`（Hocuspocus 的 `beforeHandleAwareness` 给的就是可变 Map），
 * 广播出去的那份会反映修改结果。
 *
 * 只覆盖身份字段，不动 `cursor` / `selection` / `transform` 这些 ——
 * 它们不是身份，而且每帧都在变，碰它们等于把反馈层拆了。
 *
 * 返回改写了几条，方便调用方打日志。
 */
export function enforceIdentity(
  states: Map<number, Record<string, unknown>>,
  identity: CollabIdentity | null,
): number {
  // 没启用登录（本地裸跑）时没有可信身份可用，保持原样
  if (!identity) return 0

  let rewritten = 0
  for (const state of states.values()) {
    if (!state || typeof state !== 'object') continue
    const user = state.user
    if (!user || typeof user !== 'object') continue

    // 保留客户端那份里我们不认识的字段（将来加的东西不至于被这里吃掉），
    // 但 id / name / avatarUrl 一律以服务端为准
    state.user = { ...(user as Record<string, unknown>), ...identity }
    rewritten += 1
  }
  return rewritten
}
