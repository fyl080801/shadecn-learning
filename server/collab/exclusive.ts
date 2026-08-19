import { sharedMap, stringCodec } from '../cluster/index.ts'
import { CLOSE_SUPERSEDED, closeForGood, type ClosableConnection } from './close.ts'
import type { CollabContext } from './hocuspocus.ts'
import { scopedSocketId } from './socket-id.ts'

/**
 * 一个用户、一张画布、**一条连接**。
 *
 * 同一个人开了第二个浏览器（或第二个标签页）连同一张画布时，**新的赢**：
 * 新连接接进来的那一刻，他自己那些旧连接全部被踢下线，前端弹出「协作会话已过期，
 * 请刷新页面」，并且**不再自动重连**（见 `src/composables/flow/useFlowCollab.ts`）。
 *
 * **为什么是新的赢**：人在哪个窗口，哪个窗口就是新开的那个。反过来「老的赢、新的连不上」
 * 会让用户面对一张打不开的画布，而他根本不知道自己在哪儿还开着一份。
 *
 * **粒度是「房间 × 用户」，不是「用户」**：同一个人同时开着画布 A 和画布 B 是正常工作方式，
 * 互斥只发生在同一张画布上。
 *
 * **这是体验规则，不是权限闸门** —— 权限那道在 `onConnect` / `revalidateConnections`。
 * 所以共享层（Redis）读写失败一律放行：宁可某一刻多一条连接（CRDT 本来就合得上），
 * 也不能因为缓存抖动把正在编辑的人踢下线。
 */

/**
 * 「这个房间里这个用户的连接现在是哪一条」：`<房间>:<userId>` → 连接标识。
 *
 * **多副本下必须共享**：两个窗口很可能连在不同实例上，各实例只看得见自己那半，
 * 本地判断的话谁也踢不掉谁。所以持有者写在共享层，每个实例的巡检
 * （{@link enforceExclusive}）拿它对照自己手上的连接。
 */
const holders = sharedMap<string>('collab-holder', stringCodec)

/**
 * 持有者登记的存活时间。
 *
 * 正常路径由 {@link releaseExclusive}（断连时）清掉，TTL 纯粹是给「实例崩了没来得及清」
 * 兜底的：没有它，一个早就不存在的连接会永远占着持有者的位置。巡检每轮给活着的持有者续期，
 * 所以只要连接还在，登记就不会到期。
 */
const HOLDER_TTL = 10 * 60_000

/** 巡检间隔。单副本下 `connected` 当场就踢完了，这个节奏是给跨实例那半用的 */
export const EXCLUSIVE_SWEEP_INTERVAL = 3000

/**
 * 这条连接需要什么 —— 只写用得上的字段，Hocuspocus 的 `Connection` / `Document`
 * 结构上满足它。收窄到这个形状，测试就能直接喂假对象，不用起真的 WebSocket。
 */
export interface ExclusiveConnection extends ClosableConnection {
  socketId: string
  /** `onConnect` 返回的那份 context；服务端认定的身份就在里面 */
  context: unknown
}

export interface ExclusiveDocument {
  name: string
  connections: ReadonlyMap<ExclusiveConnection, unknown>
}

/** 本实例上登记过的连接：`<房间>\0<连接标识>` → 谁的、第几个接进来的 */
interface Registration {
  room: string
  userId: string
  token: string
  /** 接入顺序；登记丢失时用来挑「最新的那条」当持有者 */
  seq: number
}

const registrations = new Map<string, Registration>()
let nextSeq = 1

function holderKey(room: string, userId: string): string {
  return `${room}:${userId}`
}

function registrationKey(room: string, token: string): string {
  return `${room}\0${token}`
}

/** 这条连接是服务端认定的哪个用户；没启用登录时没有可辨认的人，返回 null */
function userIdOf(connection: ExclusiveConnection): string | null {
  const context = connection.context as CollabContext | undefined
  return context?.identity?.id ?? null
}

function tokenOf(connection: ExclusiveConnection): string {
  return scopedSocketId(connection.socketId)
}

/**
 * 新连接接入：把持有者改成它。
 *
 * 只登记，不负责踢人 —— 踢人是 {@link enforceExclusive} 的事，两边用的是同一条判据
 * （「持有者是不是我」），本地和跨实例才不会各有一套逻辑。
 */
export async function claimExclusive(
  room: string,
  connection: ExclusiveConnection,
): Promise<void> {
  const userId = userIdOf(connection)
  if (!userId) return

  const token = tokenOf(connection)
  registrations.set(registrationKey(room, token), { room, userId, token, seq: nextSeq++ })
  await holders.set(holderKey(room, userId), token, HOLDER_TTL).catch((err: unknown) => {
    // 写不进去只意味着这一刻互斥不生效，不该影响连接本身
    console.warn(`[collab] ${room} 的单连接登记写入失败`, err)
  })
}

/**
 * 连接断开：如果持有者就是它，把登记清掉。
 *
 * **要先比对再删**：断开事件可能晚于新窗口的登记到达（刷新页面就是这个顺序），
 * 那时持有者已经是新连接了，无条件删就把新窗口的登记误删了。
 */
export async function releaseExclusive(room: string, socketId: string): Promise<void> {
  const token = scopedSocketId(socketId)
  const key = registrationKey(room, token)
  const registration = registrations.get(key)
  registrations.delete(key)
  if (!registration) return

  const holder = holderKey(room, registration.userId)
  await holders
    .get(holder)
    .then((current) => (current === token ? holders.delete(holder) : undefined))
    .catch(() => undefined)
}

/**
 * 房间散场：清掉本实例的登记。
 *
 * **只清本地**：别的实例可能还开着这个房间，删掉共享层的持有者等于替它撤销登记。
 * 共享层那份有 TTL 兜底，而且持有者是**可重算的** —— 下一轮巡检发现登记没了，
 * 会就地把还活着的连接里最新的那条补登记上去。
 */
export function forgetExclusive(room: string): void {
  const prefix = `${room}\0`
  for (const key of [...registrations.keys()]) {
    if (key.startsWith(prefix)) registrations.delete(key)
  }
}

/**
 * 巡检：把每个房间里「不是持有者」的连接顶下线，返回踢了几条。
 *
 * 新连接接入时对它自己那个房间跑一次（本地那半当场生效），此后每
 * {@link EXCLUSIVE_SWEEP_INTERVAL} 全量跑一次（跨实例那半靠它收敛，最长滞后一个间隔）。
 *
 * 三种情况分开处理，混起来会出事：
 * - **持有者就在本实例**：续一次 TTL，其余的踢掉。
 * - **持有者不在本实例**（多副本下的常态）：本地这些全都不是持有者，全踢，
 *   但**绝不能**顺手把持有者改成本地的某条 —— 那样两个实例会互相改登记、互相踢，没完没了。
 * - **登记根本不存在**（TTL 到期、Redis 被清、实例崩过）：就地把最新接入的那条补登记上去。
 *   这时才允许写登记，因为没有任何一条连接被别人认定为持有者。
 */
export async function enforceExclusive(documents: Iterable<ExclusiveDocument>): Promise<number> {
  let kicked = 0

  for (const document of documents) {
    // 这个房间里，每个用户各有哪些连接
    const byUser = new Map<string, ExclusiveConnection[]>()
    for (const connection of document.connections.keys()) {
      const userId = userIdOf(connection)
      // 没启用登录（本地裸跑）时辨认不出人，不做互斥 —— 总不能把所有人当成同一个
      if (!userId) continue
      const list = byUser.get(userId)
      if (list) list.push(connection)
      else byUser.set(userId, [connection])
    }

    for (const [userId, connections] of byUser) {
      const key = holderKey(document.name, userId)

      let holder: string | undefined
      try {
        holder = await holders.get(key)
      } catch (err) {
        // 共享层读不到就放行：互斥是体验规则，不值得为它把人踢下线
        console.warn(`[collab] ${document.name} 读取单连接登记失败，本轮放行`, err)
        continue
      }

      if (!holder) {
        holder = newestOf(document.name, connections)
        await holders.set(key, holder, HOLDER_TTL).catch(() => undefined)
      } else if (connections.some((connection) => tokenOf(connection) === holder)) {
        // 持有者还活着，续一次 TTL，免得连接还在登记先过期
        void holders.set(key, holder, HOLDER_TTL).catch(() => undefined)
      }

      for (const connection of connections) {
        if (tokenOf(connection) === holder) continue
        console.warn(`[collab] ${document.name}：用户 ${userId} 有了更新的连接，旧连接下线`)
        // 关闭要两条腿一起走，否则旧窗口会在下一次心跳时把自己接回来 —— 见 `close.ts`
        closeForGood(connection, CLOSE_SUPERSEDED)
        kicked += 1
      }
    }
  }

  return kicked
}

/** 登记丢了的时候挑一个：本实例最后接进来的那条（登记表里 seq 最大的） */
function newestOf(room: string, connections: ExclusiveConnection[]): string {
  let best = tokenOf(connections[0])
  let bestSeq = -1

  for (const connection of connections) {
    const token = tokenOf(connection)
    const seq = registrations.get(registrationKey(room, token))?.seq ?? 0
    if (seq > bestSeq) {
      best = token
      bestSeq = seq
    }
  }
  return best
}
