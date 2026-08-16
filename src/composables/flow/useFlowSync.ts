import { watch } from "vue"
import type * as Y from "yjs"

import type { useFlowStore } from "@/stores/flow"
import type { FlowTransaction } from "@/types/flow"
import type { FlowCollab } from "./useFlowCollab"

type FlowStore = ReturnType<typeof useFlowStore>

/**
 * 画布内容的实时同步。
 *
 * **传的是操作不是文档**：画布内容仍旧存在服务端的「快照 + 操作日志 + revision 乐观锁」里
 * （见 `stores/flow`），没有搬进 Y.Doc。这里只是拿 `Y.Array` 当一条**有序广播通道**用 ——
 * 本地每产生一条 `FlowTransaction` 就丢一份进去，同房间的人收到后原样 apply 一遍。
 *
 * 这么选是因为现有的操作本来就是可序列化的 `FlowOp`（它们要存进 `FlowOperation` 表、
 * 要走网络），拿来广播不用改任何数据结构；真搬进 CRDT 则要重新回答历史、撤销、
 * 审计日志怎么办 —— 那是另一个需求（见 `docs/04-realtime-collab.md` §8）。
 *
 * 几条铁律：
 * - **落库只有一方做**：谁发起谁提交，收到的一方只改内存（`store.applyRemote`），
 *   两边都提交只会互相撞 409；
 * - 提交成功的一方广播新的 `revision`，其余人对齐乐观锁基线，否则他们下一次提交必定 409；
 * - 首次同步之前收到的一律不理：那是通道里的历史，早已包含在我拉到的快照里，重放会把画布搞乱。
 */

/**
 * 通道长度上限。它只是传输管道不是账本 —— 历史在服务端的 `FlowOperation` 表里，
 * 这里留一点是给短暂断线的人补课用的，超了就从头削掉。
 */
const CHANNEL_LIMIT = 200

/** 记住多少条已处理的事务 id，用来兜底防重放 */
const SEEN_LIMIT = 500

type SyncMessage =
  | { kind: "tx"; senderId: number; transaction: FlowTransaction }
  | { kind: "revision"; senderId: number; revision: number }

function isSyncMessage(value: unknown): value is SyncMessage {
  if (!value || typeof value !== "object") return false
  const message = value as Record<string, unknown>
  if (typeof message.senderId !== "number") return false
  if (message.kind === "revision") return typeof message.revision === "number"
  if (message.kind !== "tx") return false

  const tx = message.transaction as Record<string, unknown> | undefined
  return Boolean(tx && typeof tx.id === "string" && Array.isArray(tx.ops))
}

export function useFlowSync(collab: FlowCollab, store: FlowStore) {
  watch(
    () => collab.session.value,
    (current, _prev, onCleanup) => {
      store.setSyncHooks({})
      if (!current) return

      // 存成 const 才能在下面的闭包里保住「不为 null」的收窄
      const session = current
      const channel = session.channel as Y.Array<SyncMessage>
      const seen = new Set<string>()

      function publish(message: SyncMessage) {
        channel.push([message])
        // 削头部：Yjs 的删除是墓碑，靠 GC 回收（YWS_GC 默认开着）
        if (channel.length > CHANNEL_LIMIT) {
          channel.delete(0, channel.length - CHANNEL_LIMIT)
        }
      }

      function remember(id: string) {
        if (seen.size >= SEEN_LIMIT) seen.clear()
        seen.add(id)
      }

      function handle(message: unknown) {
        if (!isSyncMessage(message)) return
        // 自己发的自己早就应用过了
        if (message.senderId === session.clientId) return

        if (message.kind === "revision") {
          store.adoptRevision(message.revision)
          return
        }
        // 兜底：命令本身是幂等的，但 node.add 重放一次就会多出一个节点，宁可挡住
        if (seen.has(message.transaction.id)) return
        remember(message.transaction.id)
        store.applyRemote(message.transaction)
      }

      function onChannelChange(event: Y.YArrayEvent<SyncMessage>) {
        // 首次同步收到的是通道里的历史，快照里早就有了，重放会把画布搞乱
        if (!session.synced.value) return
        for (const change of event.changes.delta) {
          if (!change.insert) continue
          for (const message of change.insert) handle(message)
        }
      }

      channel.observe(onChannelChange)
      store.setSyncHooks({
        onTransaction: (transaction) => {
          remember(transaction.id)
          publish({ kind: "tx", senderId: session.clientId, transaction })
        },
        onRevision: (revision) => publish({ kind: "revision", senderId: session.clientId, revision })
      })

      onCleanup(() => {
        channel.unobserve(onChannelChange)
        store.setSyncHooks({})
      })
    },
    { immediate: true }
  )
}
