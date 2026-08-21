import * as Y from 'yjs'
import { applyGraphToDoc } from '../../collab/flow-doc.ts'
import {
  flushCollabWrites,
  forgetFlow,
  loadFlowState,
  roomOf,
  storeFlowState,
} from '../../collab/persistence.ts'
import type { FlowGraph } from '../../store/flow-types.ts'

/**
 * 画布内容的测试入口。
 *
 * 内容没有 REST 写入口 —— 唯一的写路径是「客户端改 Y.Doc → WebSocket 同步 →
 * 落库」。测试不去起真的 WebSocket（线协议是 Hocuspocus 的事，我们没改），
 * 而是直接驱动同一条持久化链路：`loadFlowState` → 改文档 → `storeFlowState`。
 * 跑的是生产代码，不是替身。
 */

/** 进程内的「打开着的房间」，只在测试里用来模拟 Hocuspocus 的文档缓存 */
const openDocs = new Map<string, Y.Doc>()

/** 开一个房间：把库里的状态灌进一个新文档，等价于 Hocuspocus 的 onLoadDocument */
export async function openRoom(flowId: string): Promise<Y.Doc> {
  const name = roomOf(flowId)
  const existing = openDocs.get(name)
  if (existing) return existing

  const doc = new Y.Doc()
  const state = await loadFlowState(name)
  if (state) Y.applyUpdate(doc, state, 'persistence')
  openDocs.set(name, doc)
  return doc
}

/** 散场：落库 + 拆房间，等价于最后一个人关掉页面 */
export async function closeRoom(flowId: string): Promise<void> {
  const name = roomOf(flowId)
  const doc = openDocs.get(name)
  if (!doc) return

  // 散场等价于「人走光了」，这时才写派生投影
  await storeFlowState(name, doc, { projection: true })
  await flushCollabWrites()
  openDocs.delete(name)
  forgetFlow(name)
  doc.destroy()
}

/** 把内存里所有房间拆掉 —— 每个用例之间必须清干净，否则串数据 */
export function resetRooms(): void {
  for (const [name, doc] of [...openDocs.entries()]) {
    openDocs.delete(name)
    forgetFlow(name)
    doc.destroy()
  }
}

/** 「有人打开画布画了点东西然后离开」 */
export async function writeGraph(flowId: string, graph: FlowGraph): Promise<void> {
  const doc = await openRoom(flowId)
  applyGraphToDoc(doc, graph)
  await closeRoom(flowId)
}
