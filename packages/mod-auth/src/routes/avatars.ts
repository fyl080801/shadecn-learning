import { Hono } from 'hono'
// 引入这个模块的同时，identicon 的档案钩子就挂上了（见 avatar/index.ts）
import { isIdenticonSeed, renderIdenticon } from '../avatar/index.ts'

/**
 * 默认头像：`GET /api/avatars/<seed>.svg`。
 *
 * 图完全由种子算出来，没有数据库读写，也不认识请求者是谁 ——
 * 所以可以按不可变资源缓存：种子变了地址就变了，没有「刷新头像」这回事。
 */
export const avatars = new Hono().get('/:seed', (c) => {
  const seed = c.req.param('seed').replace(/\.svg$/, '')
  if (!isIdenticonSeed(seed)) {
    return c.json({ error: 'Not Found', message: '头像不存在' }, 404)
  }

  return c.body(renderIdenticon(seed), 200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'public, max-age=31536000, immutable',
  })
})
