import crypto from 'node:crypto'
import { minidenticon } from 'minidenticons'

/**
 * 默认头像：由身份算出来的像素方块（identicon，minidenticons 生成 SVG）。
 *
 * 图案完全由种子决定，所以**不存图片**：`User.avatarUrl` 里只存一个地址，请求进来现算。
 * 这里只有纯函数，什么时候写进 `User` 见 `user-profile.ts`。
 */

/** 头像接口前缀；写进 `User.avatarUrl` 的就是这个路径 */
export const AVATAR_PATH = '/api/avatars'

const SEED_LENGTH = 16
const SEED_PATTERN = new RegExp(`^[0-9a-f]{${SEED_LENGTH}}$`)

/** 饱和度高一点、亮度居中：浅色和深色主题下都看得清 */
const SATURATION = 75
const LIGHTNESS = 50

/**
 * 身份 → 种子。用 `(issuer, subject)` 而不是 `user.id`：它才是这个人的自然主键，重建库之后头像还是原来那张。
 * 取 sha256 截断，是为了不把 subject 明文挂在图片地址上。**改算法 = 新补的头像和旧的对不上**，`test/identicon.test.ts` 用写死的值钉着。
 */
export function identiconSeed(issuer: string, subject: string): string {
  return crypto.createHash('sha256').update(`${issuer}\n${subject}`).digest('hex').slice(0, SEED_LENGTH)
}

export function identiconUrl(issuer: string, subject: string): string {
  return `${AVATAR_PATH}/${identiconSeed(issuer, subject)}.svg`
}

/** 路由拿它挡住乱七八糟的路径：种子只可能是这个形状 */
export function isIdenticonSeed(seed: string): boolean {
  return SEED_PATTERN.test(seed)
}

/** minidenticons 输出的 svg 只有 viewBox，尺寸由 img 的样式决定。补 `crispEdges`：放大之后方块边缘不会被抗锯齿糊成灰边 */
export function renderIdenticon(seed: string): string {
  return minidenticon(seed, SATURATION, LIGHTNESS).replace('<svg ', '<svg shape-rendering="crispEdges" ')
}
