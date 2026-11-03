import { Cluster, type SharedMap, stringCodec } from '@learning/cluster'
import { Inject, Injectable } from '@nestjs/common'
import type { CollabIdentity } from './collab-auth.js'

/** 登记的存活时间：实例崩了没来得及释放时的兜底，要远大于一次重连 */
const CLAIM_TTL = 10 * 60_000

const claimKey = (room: string, clientId: number) => `${room}:${clientId}`

/**
 * clientID 的归属登记：`<房间>:<clientID>` → 首次发布它的 socket。
 * awareness 按条目自带的 clientID + clock 应用，不登记的话任何成员都能冒用队友的 clientID、抬高 clock，把对方的光标钉住，对方的真实更新还会被忽略。
 * **多副本下必须共享**：认领走 `claim()`，socket 标识带实例前缀（`CollabServer` 传进来）。
 * 共享层不可用时放行：这是防冒名的护栏，不是访问控制。
 */
@Injectable()
export class AwarenessClaims {
  private readonly claims: SharedMap<string>
  /** 每帧都跑的热路径不能每帧一次往返。归属定下就不会变，要变只能先断连，那时一并清掉 */
  private readonly localOwners = new Map<string, string>()

  constructor(@Inject(Cluster) cluster: Cluster) {
    this.claims = cluster.createMap('awareness-claims', stringCodec)
  }

  /** 把 `states` 里不属于这条连接的条目就地删掉，返回删了几条 */
  async dropForeignClients(room: string, socketId: string, states: Map<number, unknown>): Promise<number> {
    let dropped = 0
    for (const clientId of [...states.keys()]) {
      const key = claimKey(room, clientId)
      let owner = this.localOwners.get(key)
      if (owner === undefined) {
        const won = await this.claims.claim(key, socketId, CLAIM_TTL).catch(() => true)
        owner = won ? socketId : ((await this.claims.get(key).catch(() => socketId)) ?? socketId)
        this.localOwners.set(key, owner)
      }
      if (owner !== socketId) {
        states.delete(clientId)
        dropped += 1
      }
    }
    if (dropped > 0) console.warn(`[collab] ${room} 丢弃了 ${dropped} 条冒用他人 clientID 的 awareness 更新`)
    return dropped
  }

  /** 一条连接断开：释放它认领过的号码，重连的新 socket 才能接着用 */
  async releaseSocket(room: string, socketId: string): Promise<void> {
    const prefix = `${room}:`
    for (const [key, owner] of [...this.localOwners]) {
      if (key.startsWith(prefix) && owner === socketId) this.localOwners.delete(key)
    }
    const entries = await this.claims.entries(prefix).catch((): [string, string][] => [])
    await Promise.all(entries.filter(([, owner]) => owner === socketId).map(([key]) => this.claims.delete(key))).catch(() => undefined)
  }

  /** 房间散场：整张登记表作废 */
  async forgetRoom(room: string): Promise<void> {
    const prefix = `${room}:`
    for (const key of [...this.localOwners.keys()]) {
      if (key.startsWith(prefix)) this.localOwners.delete(key)
    }
    await this.claims.deleteByPrefix(prefix).catch(() => undefined)
  }
}

/**
 * 把 awareness 里客户端自报的身份换成服务端认定的那份。光标、选中可以随便报（报错了只是画面不准），「你是谁」必须由认过 cookie 的服务端说了算。
 * 只覆盖身份字段，客户端带的未知字段保留；没有 `user` 的条目（离场消息）原样放过。返回改写了几条。
 */
export function enforceIdentity(states: Map<number, Record<string, unknown>>, identity: CollabIdentity | null): number {
  if (!identity) return 0
  let rewritten = 0
  for (const state of states.values()) {
    if (!state || typeof state !== 'object') continue
    const user = state.user
    if (!user || typeof user !== 'object') continue
    state.user = { ...(user as Record<string, unknown>), ...identity }
    rewritten += 1
  }
  return rewritten
}
