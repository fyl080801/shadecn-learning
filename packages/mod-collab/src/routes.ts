import { Hono, type Context } from 'hono'
import { FLOW_STATE_VECTOR_HEADER } from '@shadecn/shared/collab'
import { clusterHealth } from '@shadecn/server-kit/cluster'
import { UNAUTHORIZED, type FlowRequestPort } from '@shadecn/server-kit/http'
import { applyFlowUpdate, decodeStateVectorParam, readFlowUpdate } from './flow-writer.ts'
import { collabStats } from './hocuspocus.ts'
import { failedStoreCount, pendingWriteCount } from './persistence.ts'
import { collabPorts } from './ports.ts'
import { COLLAB_LIMITS } from './quota.ts'

/**
 * 协同能力的 HTTP 接口（docs/28 §3.4.1）。模块装配时建、挂（`./module.ts`），入口声明全归 `collab` 角色（ingress 按路径分过来）：
 *
 * - `flowDoc`：个人画布 / 离线补推的 `/api/flows/:flowId/doc`，**挂在 `canvas.flowGuard` 之下**；
 * - `monitor`：`/api/collab/rooms`、`/api/collab/health`（在底座的登录闸门之内）。
 */
export interface CollabRoutesPorts {
  request: FlowRequestPort
  /**
   * 落库统计（日志扩展 `./logging.ts` 的 `collabLogging()` 一头一尾夹住落库数出来的）：`failed` = 累计失败次数，
   * `lastOkAt` = 最近一次成功落库的时刻。整个对象原样展开进 `/health` 的 `store` 字段（宿主多给的计数一并带上）。
   */
  storeStats(): CollabStoreStats
}

export interface CollabStoreStats {
  failed: number
  lastOkAt: number | null
}

const NOT_FOUND = { error: 'Not Found', message: '画布不存在' } as const

/**
 * 多久没成功落库就算不健康。
 *
 * 落库是**有编辑才发生**的（2 秒防抖、持续编辑最长 10 秒），所以「很久没落库」
 * 有两种完全不同的含义：没人在编辑（正常），或者落库一直在失败（故障）。
 * 靠这个数单独判断会天天误报，所以下面的判定**必须同时看 `pending`**：
 * 队列里压着东西、却又长时间没有一次成功 —— 那才是真出事了。
 */
const STALE_STORE_MS = 5 * 60_000

/** `?sv=` 是 base64url 的状态向量；给了但解不开就是 400，不要当成「没给」 */
function parseStateVector(
  raw: string | undefined,
): { ok: true; value: Uint8Array | undefined } | { ok: false; error: string } {
  if (!raw) return { ok: true, value: undefined }
  const bytes = decodeStateVectorParam(raw)
  return bytes ? { ok: true, value: bytes } : { ok: false, error: 'sv 不是合法的状态向量' }
}

/**
 * Yjs 的更新是二进制，别经 JSON —— base64 一趟平白涨三分之一。
 *
 * 状态向量走响应头（`FLOW_STATE_VECTOR_HEADER`，前端读的是同一个常量）：
 * 它是**服务端自己的进度**，客户端拿它当下次算差量的基线。
 * 不能让客户端用「合并之后的本地状态」代替 —— 那样离线期间攒下的改动会被算成
 * 「服务端已经知道了」，从此再也推不出去。
 */
function binary(c: Context, bytes: Uint8Array, stateVector: Uint8Array) {
  return c.body(bytes as unknown as ArrayBuffer, 200, {
    'content-type': 'application/octet-stream',
    'cache-control': 'no-store',
    [FLOW_STATE_VECTOR_HEADER]: Buffer.from(stateVector).toString('base64url'),
  })
}

export function createCollabRoutes(ports: CollabRoutesPorts) {
  /** 协同画布的内容不走 HTTP —— 走错通道给 409，说清楚该走哪条 */
  const rejectCollabFlow = (c: Context) =>
    ports.request.membership(c)?.kind === 'personal'
      ? null
      : c.json({ error: 'Conflict', message: '项目画布的内容走协同连接，不走这个接口' }, 409)

  /**
   * 个人画布的内容通道（REQ-SOLO）：拉一次基线 / 推一段增量。
   *
   * 协同画布**不许走这条路**（409）。绕过去的话就绕过了单连接互斥、awareness 的
   * 身份改写和内存里那个活房间 —— 写进库的东西会被房间的下一次落库整段盖掉，
   * 而客户端还以为自己存上了。两条通道各自只服务自己的模式，谁都不兼职。
   */
  const flowDoc = new Hono()
    .get('/', async (c) => {
      const denied = rejectCollabFlow(c)
      if (denied) return denied

      const since = parseStateVector(c.req.query('sv'))
      if (!since.ok) return c.json({ error: since.error }, 400)

      const state = await readFlowUpdate(c.req.param('flowId')!, since.value)
      if (!state) return c.json(NOT_FOUND, 404)

      return binary(c, state.update, state.stateVector)
    })

    .post('/', async (c) => {
      const denied = rejectCollabFlow(c)
      if (denied) return denied

      const userId = await ports.request.userId(c)
      if (!userId) return c.json(UNAUTHORIZED, 401)

      // 先看一眼声明的长度：超限的请求体没必要收完再拒
      const declared = Number(c.req.header('content-length') ?? 0)
      if (declared > COLLAB_LIMITS.message) {
        return c.json({ error: `请求体超过上限 ${COLLAB_LIMITS.message} 字节` }, 413)
      }

      const body = new Uint8Array(await c.req.arrayBuffer())
      if (body.byteLength === 0) return c.json({ error: '请求体不能为空' }, 400)

      const result = await applyFlowUpdate(c.req.param('flowId')!, body)
      if (!result.ok) {
        if (result.reason === 'not-found') return c.json(NOT_FOUND, 404)
        // 超配额是 413：请求本身合法，只是这张画布装不下了
        return c.json({ error: result.message }, 413)
      }

      return c.json({
        // 客户端存下它，下次用 `Y.encodeStateAsUpdate(doc, 这个)` 只发差量
        stateVector: Buffer.from(result.stateVector).toString('base64url'),
        revision: result.revision,
        noop: result.noop,
      })
    })

  /**
   * 协同的监控端点。
   *
   * - `GET /rooms` —— 现在有哪些房间、各自几条连接（看现场用）；
   * - `GET /health` —— **落库健康度**（接告警用，见 REQ-RESILIENCE §4.5）。
   *
   * 两个都在宿主的登录闸门之内。`/health` 里没有任何用户数据、也没有房间名，本可以放开，但那是一次**安全边界变更**，
   * 该单独评估而不是顺手做掉 —— 要给 Prometheus 抓的话，正确形态是另开一条带 token
   * 的口子，或者把 readiness 探针拆成 `/api/health/ready`（REQ-RESILIENCE §4.6 第 3 条）。
   */
  const monitor = new Hono()
    .get('/rooms', (c) => c.json(collabStats()))

    /**
     * 落库健康度。**HTTP 状态码本身就是结论**：200 好，503 不好 ——
     * 这样最土的告警（curl 判断状态码）也能接上，不必解析 JSON。
     */
    .get('/health', (c) => {
      const store = ports.storeStats()
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
      const stale = pending > 0 && store.lastOkAt !== null && Date.now() - store.lastOkAt > STALE_STORE_MS
      const ok = owed === 0 && store.failed === 0 && !stale && cluster.ok

      return c.json(
        {
          ok,
          instance: collabPorts().instanceId,
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

  return { flowDoc, monitor }
}
