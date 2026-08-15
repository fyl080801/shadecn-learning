/**
 * 画布里所有客户端生成的 id 都走这里。
 *
 * 形状是 `<前缀>_<时间戳 base36>_<随机段>`：
 * - 时间戳打头，id 按字典序就大致按产生时间排，翻日志时好认；
 * - 随机段是必须的 —— 协同时两个客户端可能在同一毫秒各加一个节点，
 *   只靠时间戳（或本地下标）会撞出同一个 id，一同步就串成同一个对象。
 */

const RANDOM_LENGTH = 8

function randomSuffix(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  let out = ""
  for (const byte of bytes) out += byte.toString(36).padStart(2, "0")
  return out.slice(0, RANDOM_LENGTH)
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomSuffix()}`
}
