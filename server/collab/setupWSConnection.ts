import type { IncomingMessage } from 'node:http'
import type { RawData, WebSocket } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

/**
 * y-websocket 服务端协议实现。
 *
 * 移植自 y-websocket 官方的 `bin/utils.js`（现 `@y/websocket-server/utils`），线上协议完全一致，
 * 浏览器端直接用标准的 `y-websocket` WebsocketProvider 即可连上。
 *
 * 这里自己实现而不是直接依赖官方包，是因为官方包在顶层 `import 'y-leveldb'`，
 * 会连带加载 leveldown 原生模块（node 22 / arm64 上没有可用的预编译产物，import 直接抛错）。
 * 我们不需要 LevelDB 持久化，去掉这一层就没有任何原生依赖了。
 *
 * 协议：消息 = [messageType: varUint, payload...]
 *   - messageSync(0)      → y-protocols/sync 的 syncStep1 / syncStep2 / update
 *   - messageAwareness(1) → y-protocols/awareness 的 awareness update
 */

const messageSync = 0
const messageAwareness = 1

const wsReadyStateConnecting = 0
const wsReadyStateOpen = 1

/** 多久没收到 pong 就认为连接已死 */
const pingTimeout = Number(process.env.YWS_PING_TIMEOUT ?? 30000)

/** 用了 snapshot 功能时需要关掉 gc */
const gcEnabled = process.env.YWS_GC !== 'false' && process.env.YWS_GC !== '0'

/** docName -> 共享文档。进程内存储，重启即丢失 */
export const docs = new Map<string, WSSharedDoc>()

interface AwarenessChange {
  added: number[]
  updated: number[]
  removed: number[]
}

export class WSSharedDoc extends Y.Doc {
  name: string
  /** conn -> 该连接持有的 awareness clientID，断开时用来清理它们的状态 */
  conns: Map<WebSocket, Set<number>> = new Map()
  awareness: awarenessProtocol.Awareness

  constructor(name: string, gc: boolean) {
    super({ gc })
    this.name = name

    this.awareness = new awarenessProtocol.Awareness(this)
    // 服务端自己不产生 awareness 状态，只做转发
    this.awareness.setLocalState(null)

    this.awareness.on('update', (change: AwarenessChange, origin: unknown) => {
      const { added, updated, removed } = change
      const changedClients = [...added, ...updated, ...removed]

      // origin 是消息来源的那条连接（本地触发时为 null）
      const controlledIds = this.conns.get(origin as WebSocket)
      if (controlledIds !== undefined) {
        for (const clientId of added) controlledIds.add(clientId)
        for (const clientId of removed) controlledIds.delete(clientId)
      }

      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
      )
      this.broadcast(encoding.toUint8Array(encoder))
    })

    this.on('update', (update: Uint8Array) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.writeUpdate(encoder, update)
      this.broadcast(encoding.toUint8Array(encoder))
    })
  }

  broadcast(message: Uint8Array) {
    for (const conn of this.conns.keys()) send(this, conn, message)
  }
}

export function getYDoc(docName: string, gc: boolean = gcEnabled): WSSharedDoc {
  let doc = docs.get(docName)
  if (doc === undefined) {
    doc = new WSSharedDoc(docName, gc)
    docs.set(docName, doc)
  }
  return doc
}

function send(doc: WSSharedDoc, conn: WebSocket, message: Uint8Array) {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    closeConn(doc, conn)
    return
  }
  try {
    conn.send(message, (err) => {
      if (err != null) closeConn(doc, conn)
    })
  } catch {
    closeConn(doc, conn)
  }
}

function closeConn(doc: WSSharedDoc, conn: WebSocket) {
  const controlledIds = doc.conns.get(conn)
  if (controlledIds !== undefined) {
    doc.conns.delete(conn)
    awarenessProtocol.removeAwarenessStates(doc.awareness, [...controlledIds], null)
  }
  conn.close()
}

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

function messageListener(conn: WebSocket, doc: WSSharedDoc, message: Uint8Array) {
  try {
    const encoder = encoding.createEncoder()
    const decoder = decoding.createDecoder(message)
    const messageType = decoding.readVarUint(decoder)

    switch (messageType) {
      case messageSync:
        encoding.writeVarUint(encoder, messageSync)
        // conn 作为 transactionOrigin 传入，保证更新不会再回发给来源连接
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn)
        // 只有 messageType 一个字节说明没有要回的内容
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder))
        }
        break
      case messageAwareness:
        awarenessProtocol.applyAwarenessUpdate(
          doc.awareness,
          decoding.readVarUint8Array(decoder),
          conn,
        )
        break
      default:
        console.warn(`[collab] 未知消息类型 ${messageType} (doc=${doc.name})`)
    }
  } catch (err) {
    console.error('[collab] 处理消息失败:', err)
  }
}

export interface SetupWSConnectionOptions {
  docName?: string
  gc?: boolean
}

export function setupWSConnection(
  conn: WebSocket,
  req: IncomingMessage,
  { docName, gc }: SetupWSConnectionOptions = {},
) {
  conn.binaryType = 'arraybuffer'

  const doc = getYDoc(docName ?? (req.url ?? '/').slice(1).split('?')[0] ?? 'default', gc)
  doc.conns.set(conn, new Set())

  conn.on('message', (data: RawData) => messageListener(conn, doc, toUint8Array(data)))

  // 心跳：ws 不会自动发现半开连接，靠 ping/pong 兜底
  let pongReceived = true
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      if (doc.conns.has(conn)) closeConn(doc, conn)
      clearInterval(pingInterval)
      return
    }
    if (doc.conns.has(conn)) {
      pongReceived = false
      try {
        conn.ping()
      } catch {
        closeConn(doc, conn)
        clearInterval(pingInterval)
      }
    }
  }, pingTimeout)

  conn.on('pong', () => {
    pongReceived = true
  })
  conn.on('close', () => {
    closeConn(doc, conn)
    clearInterval(pingInterval)
  })

  // 握手：服务端先发 syncStep1，客户端收到后回 syncStep2
  const syncEncoder = encoding.createEncoder()
  encoding.writeVarUint(syncEncoder, messageSync)
  syncProtocol.writeSyncStep1(syncEncoder, doc)
  send(doc, conn, encoding.toUint8Array(syncEncoder))

  // 把房间里已有的 awareness 状态一次性推给新连接
  const awarenessStates = doc.awareness.getStates()
  if (awarenessStates.size > 0) {
    const awarenessEncoder = encoding.createEncoder()
    encoding.writeVarUint(awarenessEncoder, messageAwareness)
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(doc.awareness, [...awarenessStates.keys()]),
    )
    send(doc, conn, encoding.toUint8Array(awarenessEncoder))
  }
}
