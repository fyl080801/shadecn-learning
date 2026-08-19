import crypto from 'node:crypto'
import { sharedMap, stringCodec } from '../cluster/index.ts'

/**
 * 权限被收回时的**跨实例广播**。
 *
 * 背景：`revalidateConnections` 每 `REAUTH_INTERVAL` 轮询一次，那是**兜底**，
 * 不是主路径。轮询决定了「被移出项目的人还能继续编辑多久」，而那段时间里他改的东西
 * 会被 CRDT 合并、落库，并且**其他人撤销不回来** —— `Y.UndoManager` 的 `trackedOrigins`
 * 只收自己的 `LOCAL_ORIGIN`，别人同步过来的改动一律不进撤销栈。所以这个窗口越短越好，
 * 正确的形状是事件驱动：谁改了权限，谁当场把人踢下去。
 *
 * 本实例好办 —— 直接跑一次复验就行。**难的是别的实例**：被移除的人的 WebSocket
 * 很可能挂在另一个 Pod 上，那个进程对这次 HTTP 请求一无所知。
 *
 * 做法是共享层里的**一个键**：改权限的人往里写一个新 token，每个实例每
 * {@link REVOCATION_POLL_INTERVAL} 读一次，发现和上次不一样就立刻跑一轮完整复验。
 *
 * **为什么是「一个全局键 + 全量复验」，而不是「按项目/按用户精确投递」**：
 * 精确投递要求每个实例知道自己手上的房间分别属于哪个项目、以及每个项目的撤销记录，
 * 读的键数跟着房间数走，还得维护一份房间→项目的缓存。而权限变更本来就**罕见**
 * （移除成员、删项目、删画布），多扫一轮的代价远小于那套映射的复杂度。
 * 平时的成本只是每实例每 3 秒读一个键 —— 内存模式下就是一次 Map 查询。
 *
 * **失败一律不阻断**：写不进去、读不出来都只记一笔，然后靠 `REAUTH_INTERVAL` 那条兜底。
 * 广播是让窗口从「一轮轮询」缩到「一次巡检」，它坏了只是慢，不是漏。
 */

const signals = sharedMap<string>('collab-revocation', stringCodec)

/** 只有一个键：权限变更的世代号。值本身没有含义，只用来比对「和上次一样吗」 */
const EPOCH_KEY = 'epoch'

/**
 * 世代号的存活时间。过期只会让下一次读看到 `undefined`（也算「变了」），
 * 于是多扫一轮 —— 无害且幂等，所以给个很长的值，让这种空转基本不发生。
 */
const EPOCH_TTL = 60 * 60_000

/** 每个实例多久看一眼。和单连接互斥巡检同一个节奏：跨实例的收敛延迟都在这个量级 */
export const REVOCATION_POLL_INTERVAL = 3000

/**
 * 宣告「有人的权限被收回了」。
 *
 * 只负责广播给**别的**实例；本实例该干的事由调用方当场做掉
 * （`revokeCollabAccess` 里紧接着就是一次复验）。所以这里不碰本地的 watcher 状态 ——
 * 本实例的 watcher 会在下一次巡检时也看到这个 token 并再扫一轮，那一轮什么也踢不到
 * （人早没了），纯属幂等的空转，不值得为它多绕一层状态同步。
 */
export async function announceRevocation(): Promise<void> {
  const token = crypto.randomUUID()
  await signals.set(EPOCH_KEY, token, EPOCH_TTL).catch((err: unknown) => {
    console.warn('[collab] 权限撤销广播写入失败，改由定期复验兜底', err)
  })
}

export interface RevocationWatcher {
  /** 自上次问起，权限有没有被谁改过 */
  changed(): Promise<boolean>
}

/**
 * 建一个观察者 —— **一个实例一个**。
 *
 * 状态（`lastSeen`）挂在这里而不是模块级，是为了能在同一个进程里造出两个「实例」
 * 来测跨实例那条路；生产环境里 `attachCollabServer` 只建一个。
 */
export function createRevocationWatcher(): RevocationWatcher {
  let lastSeen: string | undefined
  let primed = false

  return {
    async changed(): Promise<boolean> {
      let current: string | undefined
      try {
        current = await signals.get(EPOCH_KEY)
      } catch (err) {
        // 读不到就当没变：漏掉一次广播只是退回到定期复验，而误报会让所有实例白扫一轮
        console.warn('[collab] 读取权限撤销世代号失败，本轮跳过', err)
        return false
      }

      // 第一次只记不报：进程刚起来时键里本来就可能留着上一次的 token，
      // 那不代表「刚刚有人被移除」，此时所有连接也都是刚握手过的
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
