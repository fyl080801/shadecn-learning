import { Hono } from 'hono'
import { collabStats } from '../collab/index.ts'
import { failedStoreCount, pendingWriteCount } from '../collab/persistence.ts'
import { clusterHealth } from '../cluster/index.ts'
import { instanceId } from '../config.ts'
import { collabLogStats } from '../logger/collab.ts'

/**
 * 协同的监控端点。
 *
 * - `GET /rooms` —— 现在有哪些房间、各自几条连接（看现场用）；
 * - `GET /health` —— **落库健康度**（接告警用，见 REQ-RESILIENCE §4.5）。
 *
 * 两个都在登录闸门之内（`app.ts` 的 `PUBLIC_API` 只放行 `/api/health` 和 `/api/auth`）。
 * `/health` 里没有任何用户数据、也没有房间名，本可以放开，但那是一次**安全边界变更**，
 * 该单独评估而不是顺手做掉 —— 要给 Prometheus 抓的话，正确形态是另开一条带 token
 * 的口子，或者把 readiness 探针拆成 `/api/health/ready`（REQ-RESILIENCE §4.6 第 3 条）。
 */

/**
 * 多久没成功落库就算不健康。
 *
 * 落库是**有编辑才发生**的（2 秒防抖、持续编辑最长 10 秒），所以「很久没落库」
 * 有两种完全不同的含义：没人在编辑（正常），或者落库一直在失败（故障）。
 * 靠这个数单独判断会天天误报，所以下面的判定**必须同时看 `pending`**：
 * 队列里压着东西、却又长时间没有一次成功 —— 那才是真出事了。
 */
const STALE_STORE_MS = 5 * 60_000

export const collab = new Hono()
  .get('/rooms', (c) => c.json(collabStats()))

  /**
   * 落库健康度。**HTTP 状态码本身就是结论**：200 好，503 不好 ——
   * 这样最土的告警（curl 判断状态码）也能接上，不必解析 JSON。
   */
  .get('/health', (c) => {
    const store = collabLogStats()
    const cluster = clusterHealth()
    const pending = pendingWriteCount()
    const owed = failedStoreCount()
    const rooms = collabStats()

    /*
     * 两条不健康的判据，分别对应 REQ-RESILIENCE 里两类故障：
     *
     * ① 有内容没落库（§4.1）。两个数一起看：`owed` 是**此刻**还悬在内存里的画布数
     *    （落库失败后登记、重试成功才销账），`failed` 是累计失败次数（靠 hook 链的
     *    一头一尾观察出来，不需要谁去 catch）。`owed` 归零代表补齐了，
     *    `failed` 则会留着，好让人知道这个进程期间出过事。
     * ② 队列压着、又超过 STALE_STORE_MS 没有一次成功 —— 数据库跟不上或写不进去。
     *    单看时间会误报（没人编辑时本来就不落库），所以和 `pending` 一起判。
     */
    const stale =
      pending > 0 && store.lastOkAt !== null && Date.now() - store.lastOkAt > STALE_STORE_MS
    const ok = owed === 0 && store.failed === 0 && !stale && cluster.ok

    return c.json(
      {
        ok,
        instance: instanceId,
        store: {
          ...store,
          /** 距上次成功落库多少毫秒；从没落过库是 null（新起的进程就是这样） */
          sinceLastOkMs: store.lastOkAt === null ? null : Date.now() - store.lastOkAt,
          stale,
        },
        /** 还有几张画布的写排着队。持续不为 0 = 数据库跟不上，内容还只在内存里 */
        pending,
        /**
         * **现在有几张画布欠着落库** —— 落库失败过、内容还只在内存里、正在被定期重试。
         *
         * 和 `store.failed`（累计失败次数）是两个视角：那个是「历史上出过几次事」，
         * 这个是「此刻有多少内容悬着」。真出事时看的是这个 —— 它归零才代表补齐了。
         */
        owed,
        cluster,
        rooms: { total: rooms.totalRooms, connections: rooms.totalConnections },
      },
      ok ? 200 : 503,
    )
  })
