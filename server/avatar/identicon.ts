import crypto from 'node:crypto'
import { minidenticon } from 'minidenticons'

/**
 * 默认头像：GitHub 那种由身份算出来的像素方块（identicon）。
 *
 * 生成交给 minidenticons（MIT，零依赖，一个函数出一段 SVG）。图案完全由种子决定，
 * 所以**服务端不存图片**：库里只存一个地址，请求进来现算，同一个人永远是同一张。
 */

/** 头像接口前缀；写进 `User.avatarUrl` 的就是这个路径 */
export const AVATAR_PATH = '/api/avatars'

const SEED_LENGTH = 16
const SEED_PATTERN = new RegExp(`^[0-9a-f]{${SEED_LENGTH}}$`)

/** 饱和度高一点、亮度居中：浅色和深色主题下都看得清 */
const SATURATION = 75
const LIGHTNESS = 50

/**
 * 身份 → 种子。
 *
 * 用 `(issuer, subject)` 而不是 `user.id`：它才是这个人的自然主键，
 * 重建库、cuid 变了之后头像还是原来那张。取 sha256 截断，
 * 是为了不把 subject 明文挂在图片地址上。
 */
export function identiconSeed(issuer: string, subject: string): string {
  return crypto
    .createHash('sha256')
    .update(`${issuer}\n${subject}`)
    .digest('hex')
    .slice(0, SEED_LENGTH)
}

export function identiconUrl(issuer: string, subject: string): string {
  return `${AVATAR_PATH}/${identiconSeed(issuer, subject)}.svg`
}

/** 是不是我们自己发出去的那种地址（Keycloak 给了真头像时，不能被当成「没头像」） */
export function isIdenticonUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.startsWith(`${AVATAR_PATH}/`)
}

/** 路由拿它挡住乱七八糟的路径：种子只可能是这个形状 */
export function isIdenticonSeed(seed: string): boolean {
  return SEED_PATTERN.test(seed)
}

/**
 * 画出来。
 *
 * minidenticons 输出的 svg 只有 viewBox（没有固定尺寸，正好由 img 的样式说了算），
 * 这里补一个 `shape-rendering="crispEdges"`：放大之后方块边缘不会被抗锯齿糊成灰边。
 */
export function renderIdenticon(seed: string): string {
  return minidenticon(seed, SATURATION, LIGHTNESS).replace(
    '<svg ',
    '<svg shape-rendering="crispEdges" ',
  )
}
