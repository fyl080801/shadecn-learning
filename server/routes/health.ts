import { Hono } from 'hono'
import { clusterHealth } from '../cluster/index.ts'
import { prisma } from '../db.ts'

/**
 * 两个探针，**故意是两个路径**。
 *
 * - `GET /api/health` —— **浅**探针，给 liveness 和 startup 用。只回答「这个进程还在跑吗」，
 *   不碰任何依赖。
 * - `GET /api/health/ready` —— **深**探针，给 readiness 用。数据库和共享层都通才算 ready。
 *
 * 拆开的理由是这两个探针**失败时该发生的事完全相反**：
 *
 * - readiness 失败 → 把这个 Pod 从 Service 的 endpoints 里摘掉，别再往它送新请求。
 *   数据库连不上的时候，这正是想要的。
 * - liveness 失败 → **重启容器**。而重启治不了数据库故障 —— 只会让一个本来还能
 *   提供只读服务、还握着没落库内容的进程被杀掉，然后在 CrashLoopBackOff 里
 *   反复重启，把故障放大一圈。
 *
 * 所以 liveness 必须保持浅探针。以前三个 probe 共用 `/api/health`，
 * 同一个路径没法既浅又深 —— 想让 readiness 反映依赖，就只能新开一条路径。
 *
 * 两条都在登录闸门之外（`app.ts` 的 `PUBLIC_API` 放行 `/api/health` 及其子路径）：
 * kubelet 不带 cookie。所以响应里**不能有任何内部细节** —— 只有通没通，
 * 具体数字在需要登录的 `GET /api/collab/health`。
 */

const startedAt = Date.now()

/**
 * 依赖检查的超时。
 *
 * **必须自己带**：`prisma.$queryRaw` 没有默认上界，数据库进网络黑洞时这个请求会一直挂着，
 * 而 kubelet 那头只会记一次 probe 超时 —— 两者都在等，谁也不说话。
 * 自己超时才能回一个说得清的 503。
 *
 * 2 秒：比 `readinessProbe.timeoutSeconds`（默认 1s）宽，比 `periodSeconds`（10s）窄 ——
 * 探针自己先超时也没关系，那同样算失败，只是日志里少一行原因。
 */
const PROBE_TIMEOUT = 2000

function withTimeout<T>(task: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    task,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} 探测超时（${PROBE_TIMEOUT}ms）`)), PROBE_TIMEOUT),
    ),
  ])
}

/**
 * 数据库通不通。`SELECT 1` 两种 provider 都认，而且不碰任何表。
 *
 * 失败的**原因只进日志**，不进响应 —— 这个端点匿名可读，连接串、主机名、
 * 驱动的错误码都不该出现在里面。运维要细节就去看日志（那里有 module=health）。
 */
async function checkDatabase(): Promise<boolean> {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, '数据库')
    return true
  } catch (error) {
    console.warn('[health] readiness：数据库探测失败', error)
    return false
  }
}

export const health = new Hono()
  /** 浅探针：liveness / startup。不碰依赖，见文件头 */
  .get('/', (c) =>
    c.json({
      status: 'ok',
      uptime: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    }),
  )

  /**
   * 深探针：readiness。数据库 + 共享层都通才 200。
   *
   * 共享层那半是**同步**读的（ioredis 自己维护的 `status`，不发 PING），
   * 所以只有数据库那一次查询会真的等 —— 探针的耗时上界就是 `PROBE_TIMEOUT`。
   */
  .get('/ready', async (c) => {
    const database = await checkDatabase()
    const cluster = clusterHealth().ok
    const ready = database && cluster

    return c.json(
      {
        status: ready ? 'ready' : 'not-ready',
        // 只说哪个依赖不通，不带原因 —— 这个端点是匿名可读的（原因在日志里）
        database: database ? 'ok' : 'down',
        cluster: cluster ? 'ok' : 'down',
      },
      ready ? 200 : 503,
    )
  })
