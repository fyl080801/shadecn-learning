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

  abstract delete(key: string): Promise<void>

  /** 前缀扫描。用在断连清理这种冷路径上，别放进每帧都跑的地方 */
  abstract entries(prefix?: string): Promise<[string, V][]>

  abstract deleteByPrefix(prefix: string): Promise<void>
}

/**
 * 单调递增的号码机。
 *
 * 只有一个用户：`FlowOperation.seq`。它原本是「查一次库里的最大值，之后在内存里 +1」，
 * 多副本下两个进程各自 +1 就会撞唯一键。
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

/** 一套实现的出厂口。`initCluster()` 按模式挑一个 */
export interface ClusterBackend {
  createMap<V>(namespace: string, codec: Codec<V>): SharedMap<V>
  createCounter(namespace: string): SharedCounter
  createLock(namespace: string): SharedLock
  close(): Promise<void>
  /**
   * 把这个前缀下的东西全删掉。
   *
   * **只给测试用** —— 契约测试跑在真 Redis 上时不该留一地键。
   * 内存实现不需要（每次都是新的），所以是可选的。
   */
  clearAll?(): Promise<void>
}
