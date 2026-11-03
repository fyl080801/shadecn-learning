/** 值和字符串之间的编解码；Redis 那头只认字符串。内存实现也存编码后的值，读出来是新对象，行为和 Redis 一致 */
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

/** 二进制（状态向量）走 base64 */
export const bytesCodec: Codec<Uint8Array> = {
  encode: (value) => Buffer.from(value).toString('base64'),
  decode: (raw) => new Uint8Array(Buffer.from(raw, 'base64')),
}

/**
 * 一张跨进程共享的表。键由实现加上命名空间前缀，同名 namespace 就是同一张表。
 * **只有用得到的方法**（协同的 awareness、配额、持有者、状态向量，撤权世代号，总线的登记表，agent 的节点占用、任务登记、会话槽位）。
 * Redis 故障时方法会 reject，要不要 fail-open 由调用方决定。
 */
export abstract class SharedMap<V> {
  abstract get(key: string): Promise<V | undefined>
  /** 覆盖写。`ttlMs` 给了就是这么久之后自动消失 */
  abstract set(key: string, value: V, ttlMs?: number): Promise<void>
  /** 认领：键不存在时写入并返回 true，被占着就不动并返回 false。必须是一次原子操作 */
  abstract claim(key: string, value: V, ttlMs?: number): Promise<boolean>
  /**
   * 比较后写：当前值（编码后）等于 `expected` 时写入 `next` 并返回 true；键不存在或值不同返回 false，值和 TTL 都不动。
   * 写入时按 `ttlMs` 重设 TTL，**不给就是不过期**，不沿用原来的。用于持有者续期（`expected` = `next`）和转交。
   * 必须是一次原子操作：键过期后可能已经易主，先读后写会让旧持有者盖掉新主人。
   * reject 不等于没执行：对面只是不回话时，这句还在 socket 里，恢复后服务端照样执行。
   */
  abstract compareAndSet(key: string, expected: V, next: V, ttlMs?: number): Promise<boolean>
  abstract delete(key: string): Promise<void>
  /** 比较后删：当前值（编码后）相等才删。过期后键可能已经易主，旧持有者收尾时不能删掉新主人的 */
  abstract deleteIfEquals(key: string, expected: V): Promise<boolean>
  /** 前缀扫描。冷路径用，别放进每帧都跑的地方 */
  abstract entries(prefix?: string): Promise<[string, V][]>
  abstract deleteByPrefix(prefix: string): Promise<void>
}

/** 日志里的一条。`id` 只能原样交回去当游标，别解析它：内存实现是数字串，Redis 是 stream id */
export interface LogEntry<V> {
  id: string
  value: V
}

export interface LogAppendOptions {
  /** 只留最近这么多条，超出的从最老的删起（精确裁剪，不是近似） */
  maxLen?: number
  /** 整份日志（不是这一条）的 TTL，每次追加都重设；不给就不动原来的过期时间 */
  ttlMs?: number
}

/**
 * 跨进程共享的有序日志：一个进程追加，别的进程从头补读再接着跟（agent 一轮的补发缓冲）。
 *
 * - `id` 在同一份日志里单调递增，日志过期重建后也排在旧游标之后；
 * - 裁剪只删最老的。游标落在被裁掉的位置时读到的是还在的那些，**有没有漏由读的一方自己判断**（在值里带序号）；
 * - 过期是整份一起没，写的一方负责续。
 *
 * Redis 故障时方法会 reject，要不要重试由调用方决定（同 {@link SharedMap}）。
 */
export abstract class SharedLog<V> {
  /** 追加一条，返回它的 id */
  abstract append(key: string, value: V, options?: LogAppendOptions): Promise<string>
  /** `after` 之后（不含）的全部条目，按顺序；`after` 为 null 从头读 */
  abstract read(key: string, after: string | null): Promise<LogEntry<V>[]>
  /**
   * 阻塞读：`after` 之后已经有条目就立刻返回，否则等到有新条目或 `blockMs` 到点（返回空数组）。日志不存在时同样等，调用方自己循环。
   * **后端关闭时等待中的调用立刻返回空数组，之后再调就 reject**：循环的调用方不会空转，也不会拖住退出。
   */
  abstract wait(key: string, after: string | null, blockMs: number): Promise<LogEntry<V>[]>
  /** 重设整份日志的 TTL；日志不存在返回 false */
  abstract expire(key: string, ttlMs: number): Promise<boolean>
}

/**
 * 发布 / 订阅：发给此刻正在听这个频道的全部订阅者（含本进程）。
 * **只送达此刻在听的人**：订阅之前发的、订阅连接断开期间发的都丢，投递也是异步的。要可靠就让发送方能从别处确认结果。
 */
export abstract class SharedChannel<V> {
  abstract publish(channel: string, message: V): Promise<void>
  /** 返回退订函数。`handler` 抛错只记日志，不影响别的订阅者 */
  abstract subscribe(channel: string, handler: (message: V) => void): Promise<() => Promise<void>>
}
