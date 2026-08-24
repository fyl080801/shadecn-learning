import { Hono } from 'hono'
import type { ServerEnv } from '../app.ts'
import { galStoryApiUrl, galStoryTimeoutMs } from '../config.ts'

/**
 * GalStory 引擎（`gal-story serve`，FastAPI）的反向代理。
 *
 * **为什么要过一道 Node，而不是让浏览器直连 8000**：
 *
 * 1. 引擎那一侧**没有任何鉴权**，缺省只听 127.0.0.1（它自己的文档开头就写了这一条，
 *    并说「要对外就自己挡在反代加鉴权后面」）。挂在这里，`/api/*` 那道 `requireAuth`
 *    就是那层鉴权，浏览器也不必知道引擎在哪个端口上；
 * 2. 一个进程一个端口是这个项目的既有形态（dev 与 prod 都只有 Node 这一个入口），
 *    直连就要多一套 CORS 与两个 origin；
 * 3. 地址是环境变量，前端 bundle 里不留任何端点信息。
 *
 * ## 只转发 GET
 *
 * 引擎那一侧**把「要花钱 / 会写」编码成了非 GET**：`POST /api/saves/{id}/open` 首次会跑建档
 * （几十次模型调用），`DELETE /api/saves/{id}?confirm=true` 会删掉玩家几十轮的实录与知识，
 * `POST …/rollback` 会换掉整个 `state/`。所以「只放行 GET」不是一条随手加的保险，
 * 而是**贴着引擎自己那条判据**的：GET 那一族全是只读且不花钱的。
 *
 * 将来要接对局界面（开局、回退、切线），就在 `WRITE_ALLOW` 里逐条开——让「这条口会写数据」
 * 是一个看得见的决定，而不是一个 `app.all('*')` 顺手带进来的后果。
 */

/** 显式放行的非 GET 口。**逐条加**，每一条都该想清楚它会写什么。 */
const WRITE_ALLOW: ReadonlyArray<{ method: string; pattern: RegExp }> = []

const galstory = new Hono<ServerEnv>()

/** 没配地址就不是「坏了」，是「没开这块功能」—— 用 503 + 说清该配哪个变量，别回 500 */
function notConfigured() {
  return {
    error: 'GalStory 后端未配置',
    hint: '在 .env 里设 GAL_STORY_API_URL（例如 http://127.0.0.1:8000），然后重启服务端',
  }
}

galstory.all('/*', async (c) => {
  if (!galStoryApiUrl) return c.json(notConfigured(), 503)

  const method = c.req.method
  // Hono 的 basePath 已经把 /api/galstory 剥掉了，剩下的就是引擎那一侧 /api 之后的部分
  const rest = c.req.path.replace(/^\/api\/galstory/, '')
  const search = new URL(c.req.url).search
  const target = `${galStoryApiUrl}/api${rest}${search}`

  if (method !== 'GET' && !WRITE_ALLOW.some((r) => r.method === method && r.pattern.test(rest))) {
    return c.json(
      {
        error: `GalStory 代理只转发 GET（收到 ${method} ${rest}）`,
        hint: '引擎把「要花钱 / 会写」的口都放在非 GET 上；要放行就在 server/routes/galstory.ts 的 WRITE_ALLOW 里逐条加',
      },
      405,
    )
  }

  // 超时要自己给：fetch 默认没有上界，而引擎那一侧装配一局可能跑上几十秒 —— 不给的话
  // 一个卡住的上游会把这条请求永远挂着，浏览器那边只看到一个转圈的页面
  const abort = AbortSignal.timeout(galStoryTimeoutMs)
  try {
    const upstream = await fetch(target, {
      method,
      headers: { accept: 'application/json' },
      body: method === 'GET' || method === 'HEAD' ? undefined : await c.req.arrayBuffer(),
      signal: abort,
    })
    // 原样透传状态码与响应体：引擎的 404/409 都带着说人话的 detail（「这一局还没装配——先
    // POST …」），包一层「请求失败」只会把它盖掉。用裸 Response 而不是 c.json：状态码是
    // 上游给的任意值，Hono 那几个辅助方法的类型只认字面量。
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    })
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    return c.json(
      {
        error: timedOut
          ? `GalStory 后端 ${galStoryTimeoutMs}ms 没有响应`
          : `连不上 GalStory 后端（${galStoryApiUrl}）`,
        hint: timedOut ? undefined : '确认 `gal-story serve` 起着，且 GAL_STORY_API_URL 指对了',
      },
      502,
    )
  }
})

export { galstory }
