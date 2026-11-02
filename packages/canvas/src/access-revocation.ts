import { randomUUID } from 'node:crypto'
import { Cluster, type SharedMap, stringCodec } from '@learning/cluster'
import { Inject, Injectable } from '@nestjs/common'

/** 世代号的存活时间。过期只会让下一次读看到 `undefined`（也算「变了」），多扫一轮，无害 */
const EPOCH_TTL_MS = 60 * 60_000
const EPOCH_KEY = 'epoch'

/** 每个实例多久看一眼世代号：协同按这个节奏轮询 {@link RevocationWatcher} */
export const REVOCATION_POLL_INTERVAL_MS = 3000

export interface RevocationWatcher {
  /** 自上次问起，权限有没有被谁改过。第一次只记不报：进程刚起来时键里本来就可能留着上一次的 token */
  changed(): Promise<boolean>
}

type RevocationListener = () => void | Promise<void>

/**
 * 「权限可能被收回了」的信号（移除成员、删项目、删画布）。canvas 不认识协同：路由只 await {@link revoke}，协同自己订阅和轮询（docs/30 §2）。
 *
 * - **本进程**：{@link onRevoked} 的订阅者当场被调，{@link revoke} 等它们做完。`DELETE .../members/:userId` 返回 204 时，这个人已经不在本进程的画布上。
 * - **别的进程**：写共享层的世代号（一个全局键），每个进程按 {@link REVOCATION_POLL_INTERVAL_MS} 读，变了就全量复验。权限变更罕见，多扫一轮的代价远小于按项目精确投递要维护的映射。
 *
 * **失败不阻断**：写不进、读不出都只记日志，靠协同的定期复验兜底；订阅者抛错不影响别的订阅者，也不影响接口。
 */
@Injectable()
export class AccessRevocation {
  private readonly signals: SharedMap<string>
  private readonly listeners = new Set<RevocationListener>()

  constructor(@Inject(Cluster) cluster: Cluster) {
    this.signals = cluster.createMap('collab-revocation', stringCodec)
  }

  /** 收回权限之后调：先广播给别的进程，再等本进程的订阅者处理完 */
  async revoke(): Promise<void> {
    await this.signals.set(EPOCH_KEY, randomUUID(), EPOCH_TTL_MS).catch((err: unknown) => {
      console.warn('[canvas] 权限撤销广播写入失败，改由定期复验兜底', err)
    })
    await this.notify()
  }

  /** 订阅本进程的通知；返回取消函数 */
  onRevoked(listener: RevocationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 通知全部订阅者并等它们做完。轮询发现别的进程撤了权时，协同也调它 */
  async notify(): Promise<void> {
    const results = await Promise.allSettled([...this.listeners].map(async (listener) => listener()))
    for (const result of results) {
      if (result.status === 'rejected') console.error('[canvas] 权限撤销订阅者处理失败', result.reason)
    }
  }

  /** 一个进程一个。状态挂在返回值上，测试才能在同一个进程里造出两个「实例」 */
  createWatcher(): RevocationWatcher {
    let primed = false
    let lastSeen: string | undefined
    return {
      changed: async () => {
        let current: string | undefined
        try {
          current = await this.signals.get(EPOCH_KEY)
        } catch (err) {
          // 读不到就当没变：漏一次只是退回定期复验，误报会让所有实例白扫一轮
          console.warn('[canvas] 读取权限撤销世代号失败，本轮跳过', err)
          return false
        }
        if (!primed) {
          primed = true
          lastSeen = current
          return false
        }
        if (current === lastSeen) return false
        lastSeen = current
        return true
      },
    }
  }
}
