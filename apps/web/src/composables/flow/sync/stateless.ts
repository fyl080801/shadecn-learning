/**
 * 协同连接上 stateless 旁路消息的**按类型分发** —— 同步层只认 `type` 这一个字段，载荷长什么样、
 * 拿去干什么是订阅方自己的事（比如 agent 的任务列表 `agent:runs`，见 `useFlowAgent`）。
 *
 * 落库状态（`STORE_STATE_MESSAGE`）不走这里：它是传输自己的状态，由 `collab.ts` 直接认。
 *
 * **一条读不懂的消息、一个出错的订阅方都不能变成异常**：stateless 回调跑在 provider 的消息处理里，
 * 抛出去会打断整条连接的消息循环（`flow-editor.md`「parse stateless payloads defensively」）。
 */

export type StatelessHandler = (payload: string) => void

/** 取出载荷的 `type`；不是 JSON 对象、没有字符串 `type` 的一律 `null` */
export function statelessTypeOf(payload: string): string | null {
  try {
    const parsed: unknown = JSON.parse(payload)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const type = (parsed as { type?: unknown }).type
    return typeof type === "string" && type ? type : null
  } catch {
    return null
  }
}

export function createStatelessRouter() {
  const handlers = new Map<string, Set<StatelessHandler>>()

  return {
    /** 订阅某一类消息；返回退订函数 */
    on(type: string, handler: StatelessHandler): () => void {
      let set = handlers.get(type)
      if (!set) {
        set = new Set()
        handlers.set(type, set)
      }
      set.add(handler)
      return () => {
        set.delete(handler)
      }
    },
    /** 收到一条：按 `type` 交给订阅方，每个订阅方单独兜住异常 */
    dispatch(payload: string) {
      const type = statelessTypeOf(payload)
      if (!type) return
      for (const handler of [...(handlers.get(type) ?? [])]) {
        try {
          handler(payload)
        } catch (error) {
          console.warn(`[flow] 处理 stateless 消息 ${type} 失败`, error)
        }
      }
    }
  }
}

export type StatelessRouter = ReturnType<typeof createStatelessRouter>
