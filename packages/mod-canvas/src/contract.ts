import { Hono, type MiddlewareHandler } from 'hono'
import { bus, defineRequest } from '@shadecn/server-kit/bus'
import type { FlowRequestPort } from '@shadecn/server-kit/http'
import type { FlowGraph } from '@shadecn/shared/flow-graph'

/**
 * 画布模块对外的契约（REQ-MODULES，docs/28 §3.1.2 / §3.7）：别的模块要碰画布，只经这里和 `canvas` 服务。
 * 这个入口只依赖 `@shadecn/server-kit` 和 hono 的类型 —— import 它不会把画布的实现、MikroORM 拖进来。
 */

// ---------------------------------------------------------------- 服务

/** `ctx.service(CANVAS_SERVICE)` 拿到 {@link CanvasService} */
export const CANVAS_SERVICE = 'canvas'

/** 一张画布的归属（画布和它的项目都没删时才有） */
export interface FlowTarget {
  projectId: string
  kind: 'team' | 'personal'
  /** 个人空间的所有者；团队项目 = null */
  personalOwnerId: string | null
}

export interface CanvasService {
  /**
   * 画布路由的守卫（Hono 中间件）：按路径参数 `:flowId` 判请求者是不是这张画布所属项目的成员。
   * 未登录 401；画布 / 项目不存在或已删、不是成员，一律 404（不泄露存在性，docs/13 §4.8）。
   * 别的模块挂在 `/api/flows/:flowId/<x>` 下的路由**自己把它叠在最前面**，之后经 {@link request} 读身份。
   */
  readonly flowGuard: MiddlewareHandler
  /** 交给模块路由的「这个请求是谁、在这张画布上是什么身份」（membership 读的是 {@link flowGuard} 刚查到的） */
  readonly request: FlowRequestPort
  /** 画布（及其项目）没删就给出归属 */
  locate(flowId: string): Promise<FlowTarget | null>
  /** 项目里的角色；不是成员 = null（个人空间的所有者是 admin） */
  roleOf(projectId: string, userId: string): Promise<'admin' | 'member' | null>
  /** 画布内容（`Flow.ydoc`）的存取：只有协同用 */
  readonly docs: FlowDocStore
}

/**
 * 把一个模块的画布子路由包在 `flowGuard` 后面：`ctx.http.route('/api/flows/:flowId/x', underFlowGuard(canvas, routes))`。
 * 守卫必须**先于**子路由注册（Hono 按注册顺序匹配，后加的中间件拦不住先注册的处理函数），所以包一层而不是 `routes.use()`。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function underFlowGuard(canvas: CanvasService, routes: Hono<any, any, any>): Hono {
  return new Hono().use('*', canvas.flowGuard).route('/', routes)
}

// ---------------------------------------------------------------- 画布内容的存取

/** 读到的一行画布内容 */
export interface FlowDocRow {
  /** `Flow.ydoc`：Yjs 状态，**事实源**。空 / 没有 = null */
  ydoc: Uint8Array | null
  /** 服务端的 CAS 计数 */
  revision: number
  /**
   * 老数据迁移用：`ydoc` 为空时，库里那份 graph JSON 解析出来的图（坏数据已退化成空图）。
   * 只在 `read(..., { legacy: true })` 且 `ydoc` 为空时给；其余情况 null。
   */
  legacy: FlowGraph | null
}

export interface FlowDocReadOptions {
  /** 只认所属项目也没删的画布（进房、REST 读写）；落库只看画布本身没删（项目刚删时房间里那份照样写进去） */
  liveProject: boolean
  /** 要不要带上老 graph（见 {@link FlowDocRow.legacy}） */
  legacy: boolean
}

export interface FlowDocWrite {
  /** 新的 Yjs 状态 */
  ydoc: Uint8Array
  /**
   * 顺带写的派生投影（列表计数、缩略图读的 `graph`）。不给就只写 `ydoc`。
   * 序列化和字节上限由画布模块判（`GRAPH_LIMITS.bytes`，超了跳过投影、只写内容，docs/04 §4.2）。
   */
  projection?: FlowGraph
}

/**
 * `Flow` 表上协同要的那几步。写入是一次 CAS：`where revision = expectedRevision`，
 * 返回是否真的写进去了（false = 被抢先 / 已删，调用方重读重来）。
 */
export interface FlowDocStore {
  read(flowId: string, options: FlowDocReadOptions): Promise<FlowDocRow | null>
  compareAndWrite(flowId: string, expectedRevision: number, write: FlowDocWrite): Promise<boolean>
}

// ---------------------------------------------------------------- 复制前落库

/**
 * 「把这张画布在内存里的内容立刻落一次库」：画布模块要**读库里的内容**再做事（复制画布）之前发，
 * 持有活内容的模块（协同）登记处理。回话的值没有含义，到了就说明「这个实例上的那份已经写进库了」。
 */
export const CANVAS_FLUSH_CONTENT = defineRequest<{ flowId: string }, null>('canvas.flush-content')

/** 等回话的上限：一次落库是读 → 合并 → CAS 写，正常几十毫秒；超时就按「没开着」读库 */
export const FLUSH_CONTENT_TIMEOUT_MS = 5_000

/**
 * 凡是要**读库里的画布内容**再做事的接口（复制画布…）先调它：内容的事实源是内存里的 Y.Doc，
 * 库里那份只在防抖窗口和散场时更新，不叫一次就拿到上一次写入时的样子。
 *
 * 发给**所有**登记了的实例（协同房间可能同时开在好几个副本上），等它们回话或超时。**从不抛错**：
 * 没有内容持有者、某个实例超时或落库失败，都只记一笔然后照常往下走 —— 调用方读到的最差是上一次落库的内容，
 * 和改造前「房间开在别的副本上」时一样（docs/28 §3.7「请求-应答必须有退路」）。
 */
export async function flushFlowContent(flowId: string): Promise<void> {
  try {
    const result = await bus().request(CANVAS_FLUSH_CONTENT, { flowId }, { timeoutMs: FLUSH_CONTENT_TIMEOUT_MS })
    if (result.missing.length > 0 || result.failures.length > 0) {
      console.warn(
        `[canvas] 画布 ${flowId} 落库请求未全部完成（超时 ${result.missing.join(',') || '无'}；失败 ${
          result.failures.map((item) => `${item.instance}: ${item.error}`).join('; ') || '无'
        }），按库里现有内容继续`,
      )
    }
  } catch (err) {
    console.warn(`[canvas] 画布 ${flowId} 落库请求失败，按库里现有内容继续`, err)
  }
}
