/**
 * 画布里所有新建元素的 id 都走这里 —— 浏览器和服务端（agent 的画布工具）用的是同一份实现。
 *
 * 形状是 `<前缀>_<时间戳 base36>_<随机段>`：
 * - 时间戳打头，id 按字典序就大致按产生时间排，翻日志时好认；
 * - 随机段是必须的 —— 协同时两个客户端（或客户端和 agent）可能在同一毫秒各加一个节点，
 *   只靠时间戳（或本地下标）会撞出同一个 id，一同步就串成同一个对象。
 *
 * **`crypto` 从 `globalThis` 上取**：本包的 tsconfig 只给 ES2020、不给 DOM 也不给 Node 的类型
 * （两边编译的交集，见 tsconfig.json），而 Web Crypto 的 `getRandomValues` 恰好两边都有
 * （浏览器一直有，Node 从 19 起是全局的；这里跑的是 Node 22）。所以只声明用到的那一个方法，
 * 不把哪一边的整套类型拖进来 —— 拖进来护栏就失效了。
 */

interface RandomSource {
  getRandomValues<T extends Uint8Array>(array: T): T
}

const RANDOM_LENGTH = 8

function randomSource(): RandomSource {
  const source = (globalThis as { crypto?: RandomSource }).crypto
  // 两个宿主都有；真没有就是运行环境不对，宁可当场报错也不退化成 Math.random 撞 id
  if (!source) throw new Error('当前运行环境没有 crypto.getRandomValues，无法生成 id')
  return source
}

function randomSuffix(): string {
  const bytes = new Uint8Array(6)
  randomSource().getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += byte.toString(36).padStart(2, '0')
  return out.slice(0, RANDOM_LENGTH)
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomSuffix()}`
}

/**
 * 节点 / 连线的 id 前缀。前端的 `useFlowCanvas` 和服务端的画布工具都按这个建 ——
 * 前缀本身不承载语义（读的地方从不解析它），统一只是为了翻日志、看数据时一眼认得出。
 */
export const NODE_ID_PREFIX = 'n'
export const EDGE_ID_PREFIX = 'e'
