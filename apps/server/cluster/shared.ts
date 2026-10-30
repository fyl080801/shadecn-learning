/**
 * 跨实例共享状态的抽象。
 *
 * 单副本时代，这些东西全是模块级的 `Map` —— 审计的 seq、配额标记、awareness 的
 * clientID 归属、会话刷新的互斥。它们能成立全靠一个前提：**只有一个进程**。
 * 一旦多副本，每个 Map 都会分裂成 N 份互不相干的副本，
 * 轻则失效（配额各量各的），重则出错（seq 撞 `@@unique([flowId, seq])`）。
 *
 * 这里把那些用法收敛成三个抽象类，按**用途**分而不是按数据结构分：
 *
 * | 抽象 | 回答的问题 | 单副本实现 | 多副本实现 |
 * |---|---|---|---|
 * | {@link SharedMap} | 「这个键现在是什么值 / 我能不能占住它」 | `Map` | Redis string + TTL |
 * | {@link SharedCounter} | 「下一个号是几」 | 计数器 | Redis `INCR` |
 * | {@link SharedLock} | 「同一时刻只许一个人做这件事」 | 进程内 promise 去重 | Redis `SET NX` |
 * | {@link SharedLog} | 「按顺序记下来，谁都能从某处接着读」 | 数组 + 等待者 | Redis stream |
 * | {@link SharedChannel} | 「把这句话告诉正在听的那个副本」 | EventEmitter | Redis pub/sub |
 *
 * 抽象是 `abstract class` 而不是 interface：命名空间拼接、编解码这些公共逻辑
 * 写在基类里，两套实现各自只写真正不同的那几行。
 *
 * **所有方法都是异步的**，哪怕内存实现根本不需要 —— 否则接上 Redis 那天，
 * 每个调用点都要改一遍签名。调用方按异步写，单副本下也就是多一个已决议的 promise。
 */

/** 值和字符串之间的编解码；Redis 那头只认字符串 */
export interface Codec<V> {
  encode(value: V): string
  decode(raw: string): V
}

export const jsonCodec = <V>(): Codec<V> => ({
  encode: (value) => JSON.stringify(value),
  decode: (raw) => JSON.parse(raw) as V,
})

export const stringCodec: Codec<string> = {
  encode: (value) => value,
  decode: (raw) => raw,
}

export const numberCodec: Codec<number> = {
  encode: (value) => String(value),
  decode: (raw) => Number(raw),
}

/** 二进制（状态向量之类）走 base64，别指望 JSON 能原样还原 Uint8Array */
export const bytesCodec: Codec<Uint8Array> = {
  encode: (value) => Buffer.from(value).toString('base64'),
  decode: (raw) => new Uint8Array(Buffer.from(raw, 'base64')),
}

/**
 * 一张跨实例共享的表。
 *
 * 键在传进来时是「业务键」，实现会自己加上命名空间前缀 —— 调用方不用关心
 * Redis 里的键长什么样，也不会因为两个模块用了同名键而互相踩。
 */
export abstract class SharedMap<V> {
  // 不用构造函数参数属性：tsconfig 开了 erasableSyntaxOnly，那语法擦不掉
  protected readonly namespace: string
  protected readonly codec: Codec<V>

  constructor(namespace: string, codec: Codec<V>) {
    this.namespace = namespace
    this.codec = codec
  }

  abstract get(key: string): Promise<V | undefined>

  /** 覆盖写。`ttlMs` 给了就是「这么久之后自动消失」*/
  abstract set(key: string, value: V, ttlMs?: number): Promise<void>

  /**
   * 认领：键不存在时写入并返回 true，已经被别人占着则原样不动返回 false。
   *
   * 这是 awareness 归属登记的核心动作 —— 「谁先发布一个 clientID，这个号就归谁」
   * 必须是一次原子的判断加写入，先 get 再 set 会在两个实例之间漏出竞态窗口。
   */
  abstract claim(key: string, value: V, ttlMs?: number): Promise<boolean>

  /**
   * 比较后写：当前值（按 codec 编码后的字符串比）等于 `expected` 时写入 `next`
   * 并（可选）重设 TTL，返回 true；键不存在或值不同返回 false，原样不动。
   *
   * 用于持有者续期（expected = next = 自己的值）和占用转交（父 run → 子 run）。
   * **必须是一次原子的判断加写入**：键过期后可能已被别人 claim 走，先 get 再 set
   * 会让旧持有者在两步之间把别人的占用覆盖掉，或者把已经易主的键「续」回来。
   */
  abstract compareAndSet(key: string, expected: V, next: V, ttlMs?: number): Promise<boolean>

  abstract delete(key: string): Promise<void>

  /**
   * 比较后删：当前值（编码后）等于 `expected` 时删除并返回 true，否则不动返回 false。
   *
   * 用于「只删自己的占用」。同样必须原子：过期后被别人 claim 走的键，
   * 旧持有者收尾时的 delete 不能把新主人的占用一并删掉。
   */
  abstract deleteIfEquals(key: string, expected: V): Promise<boolean>

  /** 前缀扫描。用在断连清理这种冷路径上，别放进每帧都跑的地方 */
  abstract entries(prefix?: string): Promise<[string, V][]>

  abstract deleteByPrefix(prefix: string): Promise<void>
}

/**
 * 单调递增的号码机。
 *
 * **目前没有生产用户**（原先的用户是画布的操作日志 `FlowOperation.seq`，已经去掉）。
 * 抽象连同两份实现和契约测试一起留着：跨副本发号是个反复出现的需求
 * （「进程内 +1」在多副本下必然撞号），需要时直接 `sharedCounter(namespace)` 就能用。
 */
export abstract class SharedCounter {
  protected readonly namespace: string

  constructor(namespace: string) {
    this.namespace = namespace
  }

  /**
   * 取下一个号。
   *
   * `seed()` 只在这个键**第一次**被用到时调用，返回「已经用掉的最大值」
   * （对 seq 来说就是库里的 `max(seq)`，没有就是 0），第一个发出去的号是它 +1。
   *
   * 播种要放在实现里而不是调用方，是因为 Redis 是缓存：它随时可能被清空或重启，
   * 那之后必须能从库里重新对齐，否则号会退回去撞已经写下的行。
   */
  abstract next(key: string, seed: () => Promise<number>): Promise<number>

  abstract forget(key: string): Promise<void>
}

/**
 * 「同一时刻只许一个人做这件事」。
 *
 * 用在会话刷新上：同一个会话被两个请求同时撞到过期点时，只该有一次真的去
 * Keycloak 换 token —— refresh token 一旦开了轮换，第二次换就会被判 `invalid_grant`，
 * 把好端端的会话干掉。
 */
export abstract class SharedLock {
  protected readonly namespace: string

  constructor(namespace: string) {
    this.namespace = namespace
  }

  /**
   * 抢到锁就跑 `task`；没抢到就等着，等到之后跑 `fallback`。
   *
   * 两种实现的语义**故意不完全一样**，但都满足「不并发执行 task」：
   * - 进程内实现直接复用同一个 in-flight promise，后来者拿到的就是同一个结果；
   * - Redis 实现做不到跨进程共享 promise，所以后来者等锁释放，然后跑 `fallback`
   *   （通常是「重读一遍库」—— 那时赢家已经把结果写进去了）。
   *
   * 也就是说 `fallback` 必须能独立得出正确答案，不能假设 task 的返回值。
   */
  abstract run<T>(
    key: string,
    task: () => Promise<T>,
    options: { fallback: () => Promise<T>; ttlMs?: number },
  ): Promise<T>
}

/** 有序日志里的一条：`id` 由实现发放，只能原样交回（当 {@link SharedLog.read} 的起点），别解析它 */
export interface LogEntry<V> {
  id: string
  value: V
}

export interface LogAppendOptions {
  /** 只留最近这么多条：超出的从最老的删起（**精确**裁剪，不是近似） */
  maxLen?: number
  /** 整份日志（不是这一条）的 TTL：每次追加都重设；不给 = 不动原来的过期时间 */
  ttlMs?: number
}

/**
 * 一份跨实例共享的**有序日志**：追加、从某一条之后读、阻塞等新条目，带长度上限和整份过期。
 *
 * 用在「一个副本在写、别的副本要从头补读再接着跟」的场景（agent 一轮的补发缓冲，docs/20 §3.10.10）。
 * 和 {@link SharedMap} 的区别是**顺序与游标**：读的一方拿上次读到的 `id` 接着读，不漏不重；
 * 写的一方只管追加。
 *
 * - `id` 在同一份日志里单调递增，**不透明**（内存实现是数字串，Redis 是 stream id）；
 * - 裁剪（`maxLen`）只删最老的，游标落在被裁掉的位置时，读到的是还在的那些（**读的一方自己判断有没有漏**，
 *   比如在值里带序号）；
 * - 过期是整份日志一起没（`ttlMs` / {@link expire}），写的一方负责续。
 */
export abstract class SharedLog<V> {
  protected readonly namespace: string
  protected readonly codec: Codec<V>

  constructor(namespace: string, codec: Codec<V>) {
    this.namespace = namespace
    this.codec = codec
  }

  /** 追加一条，返回它的 id */
  abstract append(key: string, value: V, options?: LogAppendOptions): Promise<string>

  /** `after` 之后（不含）的条目，按顺序；`after` 为 null 从头读；`count` 是这次最多读几条 */
  abstract read(key: string, after: string | null, count?: number): Promise<LogEntry<V>[]>

  /**
   * 阻塞读：`after` 之后已经有条目就立刻返回它们，否则等到有新条目、或 `blockMs` 到点（返回空数组）。
   * 日志不存在时同样等（写的一方可能还没写第一条）。`blockMs` 必须大于 0，调用方自己循环。
   */
  abstract wait(key: string, after: string | null, blockMs: number): Promise<LogEntry<V>[]>

  /** 重设整份日志的 TTL；日志不存在返回 false */
  abstract expire(key: string, ttlMs: number): Promise<boolean>

  abstract delete(key: string): Promise<void>
}

/**
 * 跨实例的**发布 / 订阅**：把一条消息发给此刻正在听某个频道的所有订阅者（含本进程自己）。
 *
 * 用在「这件事只有某个副本做得了，请求却落在了别的副本」的场景（agent 跨副本停止，docs/20 §3.10.10）。
 * **只管送达此刻在听的人**：没人听、订阅之前发的、订阅连接断开期间发的，都丢 —— 要可靠就别用它，
 * 或者让发送方能从别处（登记表）确认结果。投递是异步的：`publish` 兑现时订阅者不一定已经收到。
 *
 * 订阅在 `initCluster()` **之后**建立（换 backend 不迁移已有订阅）。
 */
export abstract class SharedChannel<V> {
  protected readonly namespace: string
  protected readonly codec: Codec<V>

  constructor(namespace: string, codec: Codec<V>) {
    this.namespace = namespace
    this.codec = codec
  }

  abstract publish(channel: string, message: V): Promise<void>

  /** 订阅一个频道；返回退订函数。`handler` 抛错只记日志，不影响别的订阅者 */
  abstract subscribe(channel: string, handler: (message: V) => void): Promise<() => Promise<void>>
}

/** 一套实现的出厂口。`initCluster()` 按模式挑一个 */
/** 共享层的健康快照 */
export interface ClusterHealth {
  /** 现在能用吗。单副本恒为 true —— 那时「共享层」就是进程内存 */
  ok: boolean
  /** 后端类型，`memory` / `redis` */
  backend: 'memory' | 'redis'
  /** 后端自己报的状态，排查时有用（ioredis 的 `ready` / `connecting` / `end` …） */
  status: string
}

export interface ClusterBackend {
  createMap<V>(namespace: string, codec: Codec<V>): SharedMap<V>
  createCounter(namespace: string): SharedCounter
  createLock(namespace: string): SharedLock
  /** 同一个 backend 上同名的日志 / 频道是同一份（和 Redis 上同名键一致），不论 `create` 了几次 */
  createLog<V>(namespace: string, codec: Codec<V>): SharedLog<V>
  createChannel<V>(namespace: string, codec: Codec<V>): SharedChannel<V>
  close(): Promise<void>
  /**
   * 共享层现在还好使吗 —— 给监控端点读。
   *
   * **必须是同步的、不发网络请求**：这是健康检查读的东西，而健康检查本身
   * 不能因为依赖挂了就跟着卡住（那会把「Redis 慢」变成「健康检查超时」，
   * 两件事的处置完全不同）。Redis 那头读连接对象自己的 `status` 就够了，
   * ioredis 一直在维护它。
   */
  health(): ClusterHealth
  /**
   * 把这个前缀下的东西全删掉。
   *
   * **只给测试用** —— 契约测试跑在真 Redis 上时不该留一地键。
   * 内存实现不需要（每次都是新的），所以是可选的。
   */
  clearAll?(): Promise<void>
}
