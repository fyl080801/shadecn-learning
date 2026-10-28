import type { Extension } from '@hocuspocus/server'
import { logger } from './logger.ts'

/**
 * 协同链路的日志 —— 一个**只做日志的 Hocuspocus Extension**。
 *
 * Hocuspocus 的 `extensions` 本来就是给横切关注点用的：每个 hook 会依次跑过所有
 * extension。所以「给协同加日志」的正确形状是往那个数组里塞一个对象，
 * 而不是在 `hocuspocus.ts` 已有的十几个 hook 里各插一行 —— 那些 hook 里写的是配额、
 * 鉴权、互斥这些**规则**，掺进日志之后就再也读不出规则本身了。
 *
 * **执行顺序是这个 extension 能成立的前提。** Hocuspocus 在 `configure()` 里把
 * `new Hocuspocus({ onStoreDocument, ... })` 那些配置项包成一个 extension **push 到数组末尾**，
 * 所以业务 hook 永远最后跑。再给我们标上 `priority`，就得到一个夹心：
 *
 *   我们的 onStoreDocument（开始）→ Redis extension → 业务的真正落库
 *   ……全部成功之后 →  我们的 afterStoreDocument（完成）
 *
 * `afterStoreDocument` 只在整条链成功后才会被调用，于是**「开始」和「完成」两个计数的差
 * 就是失败次数** —— 不需要在业务代码里插一行 try/catch 就能算出落库健康度。
 * 失败的**内容**也不用我们管：Hocuspocus 自己会 `console.error("Caught error during
 * storeDocumentHooks...")`，而 console 已经被接管，那条会自动变成结构化的 error 日志。
 */

/** 落库健康度 —— 正对着 REQ-RESILIENCE §4.5 想要的那几个数 */
interface StoreStats {
  /** 进入落库流程的次数 */
  started: number
  /** 真正落库成功的次数；`started - completed` 就是失败数 */
  completed: number
  /** 最近一次成功落库的时刻 */
  lastOkAt: number | null
}

/**
 * **进程启动以来的累计**，永不清零 —— 监控端点读的是它。
 *
 * 和下面的 `recent` 分开是必须的：汇总日志每分钟把窗口清零，
 * 而告警要的恰恰是「累计失败了多少次」「多久没成功落库了」。
 * 共用一份计数的话，一次汇总就会把刚发生的失败从告警眼皮底下抹掉。
 */
const stats: StoreStats = { started: 0, completed: 0, lastOkAt: null }

/** 汇总窗口内的计数，每分钟清零；只服务于那条汇总日志 */
const recent = { started: 0, completed: 0 }

/** 每个房间这一轮累计的更新次数 / 字节数 —— 汇总时一起报，不逐条打 */
const rooms = new Map<string, { updates: number; bytes: number }>()

/** 汇总心跳间隔。一分钟一条；这一分钟没有任何落库就一条都不打 */
const SUMMARY_INTERVAL = 60_000

function room(name: string) {
  let entry = rooms.get(name)
  if (!entry) {
    entry = { updates: 0, bytes: 0 }
    rooms.set(name, entry)
  }
  return entry
}

/**
 * 当前快照，给监控接口（`GET /api/collab/health`）读。
 *
 * 日志能被人看见，但接不上告警；这几个数才能 —— 尤其是
 * `failed`（有多少次落库没走完）和 `lastOkAt`（多久没成功落库了）。
 *
 * **都是本进程启动以来的累计**，不随汇总清零；多副本下每个实例各报各的
 * （日志和响应里都带 `instance`，聚合是采集端的事）。
 */
export function collabLogStats(): StoreStats & { failed: number; rooms: number } {
  return { ...stats, failed: stats.started - stats.completed, rooms: rooms.size }
}

/**
 * 把统计清回起点。**只给测试用** —— 累计计数是进程级的，而后端测试全在同一个
 * 进程里串行跑（`fileParallelism: false`），一个用例故意造出来的失败会漏给下一个。
 *
 * 生产里没有调用点，也不该有：这些数的意义就是「从进程起来到现在」。
 */
export function resetCollabLogStats(): void {
  stats.started = 0
  stats.completed = 0
  stats.lastOkAt = null
  recent.started = 0
  recent.completed = 0
  rooms.clear()
}

function summarize(): void {
  if (recent.started === 0) return

  let updates = 0
  let bytes = 0
  for (const entry of rooms.values()) {
    updates += entry.updates
    bytes += entry.bytes
  }

  const failed = recent.started - recent.completed
  logger.log(failed > 0 ? 'warn' : 'info', '协同落库汇总', {
    module: 'collab',
    stored: recent.completed,
    failed,
    rooms: rooms.size,
    updates,
    /** 这一分钟里内容**变化**了多少字节（不是文档大小，见 `onChange`） */
    changedBytes: bytes,
  })

  recent.started = 0
  recent.completed = 0
  for (const entry of rooms.values()) {
    entry.updates = 0
    entry.bytes = 0
  }
}

/**
 * 建一个日志 extension；额外带一个 `dispose`，退出时清掉汇总定时器并补最后一条。
 *
 * **hook 里绝不 throw，也绝不做重活**，两条都是硬要求：
 * - hook 链是串行的，日志里抛一个异常会把后面的业务 hook 全部掐掉 ——
 *   一个只该观察的东西变成了故障源；
 * - `Y.encodeStateAsUpdate()` 会把整个文档序列化一遍，文档上限是 20MB，
 *   为了在日志里写一个 `bytes=` 而付这个代价是不值的。所以规模用 `onChange` 里
 *   现成的 `update.byteLength` 累加，那是**已经在手里**的数字。
 */
export function collabLogging(): Extension & { dispose: () => void } {
  const timer = setInterval(summarize, SUMMARY_INTERVAL)
  // 汇总是观察手段，不该成为进程活着的理由
  timer.unref()

  return {
    /** 排在业务 hook 之前跑（业务那份被 Hocuspocus 固定 push 在最后），见文件头 */
    priority: 1000,

    async onConnect(data) {
      logger.debug('握手', { module: 'collab', room: data.documentName, socket: data.socketId })
    },

    async connected(data) {
      logger.info('连接建立', {
        module: 'collab',
        room: data.documentName,
        socket: data.connection.socketId,
        clients: data.connection.document.getConnectionsCount(),
      })
    },

    async onDisconnect(data) {
      logger.info('连接断开', {
        module: 'collab',
        room: data.documentName,
        socket: data.socketId,
        clients: data.clientsCount,
      })
    },

    async onLoadDocument(data) {
      logger.info('房间加载', { module: 'collab', room: data.documentName })
    },

    /**
     * 每次编辑都会走这里 —— **只累加，不写日志**。
     * 一个人拖一个节点就是几十次 update，逐条打等于把日志写成噪音墙。
     */
    async onChange(data) {
      const entry = room(data.documentName)
      entry.updates += 1
      entry.bytes += data.update.byteLength
    },

    /** 落库开始。真正写库的是业务 hook，它排在我们后面 */
    async onStoreDocument(data) {
      stats.started += 1
      recent.started += 1
      logger.debug('开始落库', {
        module: 'collab',
        room: data.documentName,
        clients: data.clientsCount,
      })
    },

    /** 落库**完成** —— 整条 onStoreDocument 链都成功了才会走到这里 */
    async afterStoreDocument(data) {
      stats.completed += 1
      recent.completed += 1
      stats.lastOkAt = Date.now()
      logger.debug('落库完成', { module: 'collab', room: data.documentName })
    },

    async beforeUnloadDocument(data) {
      const entry = rooms.get(data.documentName)
      logger.info('房间卸载', {
        module: 'collab',
        room: data.documentName,
        updates: entry?.updates ?? 0,
      })
      rooms.delete(data.documentName)
    },

    dispose() {
      clearInterval(timer)
      // 最后补一条汇总，别让刚过去那不到一分钟的落库情况随进程一起消失
      summarize()
      rooms.clear()
    },
  }
}
