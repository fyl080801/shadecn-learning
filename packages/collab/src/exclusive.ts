import { Cluster, type SharedMap, stringCodec } from '@learning/cluster'
import { CLOSE_SUPERSEDED } from '@learning/contracts/collab'
import { Inject, Injectable } from '@nestjs/common'
import { type ClosableConnection, closeForGood } from './close.js'

/** 持有者登记的存活时间：实例崩了的兜底，巡检给活着的持有者续期 */
const HOLDER_TTL = 10 * 60_000

/** 巡检间隔。单副本下 `connected` 当场就踢完了，这个节奏是给跨实例那半用的 */
export const EXCLUSIVE_SWEEP_INTERVAL = 3000

/** 只写用得上的字段：测试能喂假对象，Hocuspocus 的 `Connection` / `Document` 结构上满足它 */
export interface ExclusiveConnection extends ClosableConnection {
  socketId: string
  /** `onConnect` 返回的 context；服务端认定的身份在里面 */
  context: unknown
}

export interface ExclusiveDocument {
  name: string
  connections: ReadonlyMap<ExclusiveConnection, unknown>
}

interface Registration {
  userId: string
  /** 接入顺序；登记丢失时用来挑最新的那条 */
  seq: number
}

/**
 * 一个用户、一张画布、一条连接，**新的赢**：人在哪个窗口，哪个窗口就是新开的。粒度是房间 × 用户。
 * 这是体验规则，不是权限闸门：共享层失败一律放行，宁可某一刻多一条连接（CRDT 合得上），也不能把正在编辑的人踢下线。
 * 持有者放共享层：两个窗口可能连在不同副本上。
 */
@Injectable()
export class ExclusiveConnections {
  private readonly holders: SharedMap<string>
  /** 本实例登记过的连接：`<房间>\0<连接标识>` */
  private readonly registrations = new Map<string, Registration>()
  private nextSeq = 1
  private readonly instanceId: string

  constructor(@Inject(Cluster) cluster: Cluster) {
    this.holders = cluster.createMap('collab-holder', stringCodec)
    this.instanceId = cluster.instanceId
  }

  private userIdOf(connection: ExclusiveConnection): string | null {
    return (connection.context as { identity?: { id?: string } | null } | undefined)?.identity?.id ?? null
  }

  /** socketId 只在进程内唯一，比对持有者要带实例前缀 */
  private tokenOf(socketId: string): string {
    return `${this.instanceId}:${socketId}`
  }

  /** 新连接接入：把持有者改成它。只登记不踢人，踢人是 {@link enforce} 的事，本地和跨实例才是同一条判据 */
  async claim(room: string, connection: ExclusiveConnection): Promise<void> {
    const userId = this.userIdOf(connection)
    if (!userId) return
    const token = this.tokenOf(connection.socketId)
    this.registrations.set(`${room}\0${token}`, { userId, seq: this.nextSeq++ })
    await this.holders.set(`${room}:${userId}`, token, HOLDER_TTL).catch((err: unknown) => {
      console.warn(`[collab] ${room} 的单连接登记写入失败`, err)
    })
  }

  /** 连接断开：持有者是它才清。断开事件可能晚于新窗口的登记（刷新页面就是这个顺序），无条件删会误删新窗口的 */
  async release(room: string, socketId: string): Promise<void> {
    const token = this.tokenOf(socketId)
    const key = `${room}\0${token}`
    const registration = this.registrations.get(key)
    this.registrations.delete(key)
    if (!registration) return
    await this.holders.deleteIfEquals(`${room}:${registration.userId}`, token).catch(() => undefined)
  }

  /** 房间散场：只清本地。别的实例可能还开着，共享层有 TTL，持有者也可重算 */
  forgetRoom(room: string): void {
    const prefix = `${room}\0`
    for (const key of [...this.registrations.keys()]) {
      if (key.startsWith(prefix)) this.registrations.delete(key)
    }
  }

  /**
   * 巡检：把不是持有者的连接顶下线，返回踢了几条。三种情况分开处理：
   * - 持有者在本实例：续 TTL，其余的踢掉；
   * - 持有者不在本实例：本地这些全踢，**绝不能**顺手改登记，否则两个实例互相改、互相踢；
   * - 登记不存在（TTL 到期、实例崩过）：才允许写登记，把最新接入的那条补上。
   */
  async enforce(documents: Iterable<ExclusiveDocument>): Promise<number> {
    let kicked = 0
    for (const document of documents) {
      const byUser = new Map<string, ExclusiveConnection[]>()
      for (const connection of document.connections.keys()) {
        const userId = this.userIdOf(connection)
        if (!userId) continue
        const list = byUser.get(userId)
        if (list) list.push(connection)
        else byUser.set(userId, [connection])
      }

      for (const [userId, connections] of byUser) {
        const key = `${document.name}:${userId}`
        let holder: string | undefined
        try {
          holder = await this.holders.get(key)
        } catch (err) {
          console.warn(`[collab] ${document.name} 读取单连接登记失败，本轮放行`, err)
          continue
        }

        if (!holder) {
          holder = this.newestOf(document.name, connections)
          await this.holders.set(key, holder, HOLDER_TTL).catch(() => undefined)
        } else if (connections.some((connection) => this.tokenOf(connection.socketId) === holder)) {
          void this.holders.set(key, holder, HOLDER_TTL).catch(() => undefined)
        }

        for (const connection of connections) {
          if (this.tokenOf(connection.socketId) === holder) continue
          console.warn(`[collab] ${document.name}：用户 ${userId} 有了更新的连接，旧连接下线`)
          closeForGood(connection, CLOSE_SUPERSEDED)
          kicked += 1
        }
      }
    }
    return kicked
  }

  /** 登记丢了的时候挑一个：本实例最后接进来的那条 */
  private newestOf(room: string, connections: ExclusiveConnection[]): string {
    let best = this.tokenOf(connections[0].socketId)
    let bestSeq = -1
    for (const connection of connections) {
      const token = this.tokenOf(connection.socketId)
      const seq = this.registrations.get(`${room}\0${token}`)?.seq ?? 0
      if (seq > bestSeq) {
        best = token
        bestSeq = seq
      }
    }
    return best
  }
}
