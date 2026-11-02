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
 * **只有用得到的方法**（协同的 awareness、配额、持有者、状态向量，撤权世代号，总线的登记表）。
 * Redis 故障时方法会 reject，要不要 fail-open 由调用方决定。
 */
export abstract class SharedMap<V> {
  abstract get(key: string): Promise<V | undefined>
  /** 覆盖写。`ttlMs` 给了就是这么久之后自动消失 */
  abstract set(key: string, value: V, ttlMs?: number): Promise<void>
  /** 认领：键不存在时写入并返回 true，被占着就不动并返回 false。必须是一次原子操作 */
  abstract claim(key: string, value: V, ttlMs?: number): Promise<boolean>
  abstract delete(key: string): Promise<void>
  /** 比较后删：当前值（编码后）相等才删。过期后键可能已经易主，旧持有者收尾时不能删掉新主人的 */
  abstract deleteIfEquals(key: string, expected: V): Promise<boolean>
  /** 前缀扫描。冷路径用，别放进每帧都跑的地方 */
  abstract entries(prefix?: string): Promise<[string, V][]>
  abstract deleteByPrefix(prefix: string): Promise<void>
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
