import { Hono } from 'hono'
import type { ServerEnv } from '../app.ts'
import { galStoryApiUrl, galStoryGatewayToken, galStoryTimeoutMs } from '../config.ts'

/**
 * 网关注入给引擎的两个头（引擎侧的唯一声明处是 `gal_server/principal.py`）。
 * ⚠️ 名字要与那边逐字一致 —— 写错不会报错，只会静默落到引擎的缺省属主上。
 */
const OWNER_HEADER = 'X-Gal-Owner'
const GATEWAY_TOKEN_HEADER = 'X-Gal-Gateway-Token'

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
 *
 * ## 用户 ↔ 故事实例的关联就在这一层，而且只有一行
 *
 * 每条转发都带上 `X-Gal-Owner: <登录用户的 id>`。引擎按属主分存档目录
 * （`<storage>/<owner>/<save-id>/`），并且**产出的不是「通过了」这个布尔，是这次请求的
 * SaveLocator** —— 隔离因此是**结构性**的：拿不到别人的 `Path` 就越不了权。于是
 * 「这个用户玩过哪些实例」这个问题的答案就是 `GET /saves`：不需要在本服务再存一张
 * 用户↔存档的映射表。
 *
 * ⚠️ **刻意不建那张表**。存了就有两处真相：引擎删掉一个存档，本地那行不会跟着没；
 * 用户在 CLI 上新建一个，本地那张表也看不见。而「同一个判据两处声明、漂了还不报错」正是
 * 这两个仓库反复栽过的形态。这一层要做的只是**把身份翻译成属主**，不是替引擎记账。
 *
 * ⚠️ 用户 id 是 cuid（`[a-z0-9]+`），正好落在引擎那条属主字符集 `[A-Za-z0-9_-]{1,64}` 内 ——
 * 它要当目录名。换成别的身份源（邮箱、Keycloak subject 带冒号的那种）之前先想一遍这条。
 */

/**
 * 显式放行的非 GET 口。**逐条加**，每一条都该想清楚它会写什么。
 *
 * 下面这一族写的是引擎的 `config.yaml`（模型连接 / 采样预设 / 各环节的覆盖项）。它们**不花钱、
 * 不碰任何存档**——玩家几十轮的实录、知识库与关系日志一个字都不会动，这是它们与 `saves` 那一族
 * （开局要跑建档、删存档、回退换掉整个 `state/`）的分界，也是这里只开这一族的理由。
 *
 * ⚠️ 正则**两端都要锚定**：`^/config$` 之类不加 `$` 的话，`/config/../saves/x` 这种也能匹配上。
 * 路径里那段 id 用 `[^/]+`（不许再往下钻一层）。
 */
const WRITE_ALLOW: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  // ── 模型配置 ──
  // 顶层几个键：默认连接 / 核验总开关 / agent 绑定 / 日志 / skill 与插件增量
  { method: 'PATCH', pattern: /^\/config$/ },
  // 一条模型连接、一个采样预设、一个环节的覆盖项
  { method: 'PUT', pattern: /^\/config\/(connections|presets|agents)\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/config\/(connections|presets|agents)\/[^/]+$/ },

  // ── 存档生命周期（对局界面要的那几条）──
  // ⚠️ 这一族**会花钱、会删数据**，与上面那族不是一回事：
  // `POST /saves/{id}/open` 首次会跑建档（几十次模型调用）、`POST .../turns` 演一轮，
  // `DELETE /saves/{id}` 删掉玩家几十轮的实录与知识。放行它们的前提是**属主隔离**：
  // 下面每条请求都带上 `X-Gal-Owner`，引擎按属主分目录，拿不到别人的 Path 就越不了权。
  // ── 我的故事（作者面，2026-08-30）──
  // 这一族**不花钱、不碰任何存档**（删故事也不级联删存档——存档自带整份模板副本），
  // 与 `saves` 那族的分界与 `config` 那族相同。属主隔离仍由 `X-Gal-Owner` 那一行给：
  // 引擎的写口 base 只有 `<authoring>/<owner>/`，拿不到别人的 `Path` 就改不了。
  { method: 'POST', pattern: /^\/stories$/ },
  { method: 'PATCH', pattern: /^\/stories\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/stories\/[^/]+$/ },
  // ⚠️ **文件那两条只能用 `.+`，上面那条「一段 id 用 `[^/]+`」的约定在这里用不了**：
  // 可编辑路径本来就带层级（`characters/npc.yaml`、`knowledge/stories/npc.yaml`）。
  // 放宽的**前提是引擎那一侧才是判据的唯一声明处**（`gal_story.authoring.editable_path`：
  // 白名单目录 + 只认 `.yaml` + 解析后必须仍在故事根内，`..` 与绝对路径一律不认）——
  // 在这里再判一遍就是**同一个判据两处声明**，而漂了不报错：这边少认一条只是「这个字段
  // 改不了」，多认一条则等于绕过那道白名单。故这一层只管「哪个方法哪条路放行」。
  { method: 'PUT', pattern: /^\/stories\/[^/]+\/files\/.+$/ },
  { method: 'DELETE', pattern: /^\/stories\/[^/]+\/files\/.+$/ },

  { method: 'POST', pattern: /^\/saves$/ },
  { method: 'DELETE', pattern: /^\/saves\/[^/]+$/ },
  { method: 'POST', pattern: /^\/saves\/[^/]+\/open$/ },
  { method: 'POST', pattern: /^\/saves\/[^/]+\/turns$/ },
  // ⚠️ **回退与切线刻意没放行**：它们会整个换掉 `state/`，而界面上还没有对应的入口。
  // 要做「读档回到某一场」时再逐条加 —— 别为了「顺手」提前开。
]

/**
 * 这条路最多等多久。
 *
 * **绝大多数口都是快的**，唯独一条不是：`POST /saves/{id}/open` 会跑建档（归一化 + 公开人物志
 * + 按 observer 分调的初次印象 + 泄密判定，几十次模型调用），几分钟起步。拿同一个 30s 去卡它，
 * 症状是「界面报连不上后端」——而引擎其实好好的，只是这一次请求本来就要那么久。
 *
 * ⚠️ **对局界面并不走那条口**（见 `useGalStoryRun`）：演一轮那条 `POST .../turns` 立刻回 202，
 * 装配发生在 worker 里、进度走事件流。这里给 `/open` 留一个长超时，是为了别人直接调它时
 * 不会莫名其妙地被掐 —— 不是为了让前端去依赖它。
 */
function timeoutFor(path: string): number {
  return /^\/saves\/[^/]+\/open$/.test(path) ? Math.max(galStoryTimeoutMs, 600_000) : galStoryTimeoutMs
}

const galstory = new Hono<ServerEnv>()

/**
 * 按 fetch 规范**不能带 body** 的那几个状态码。
 *
 * 引擎的 `DELETE /saves/{id}` 回 204，而 `new Response('', { status: 204 })` 在 undici 上直接
 * 抛 TypeError —— 那个异常会被 catch 接住、报成「连不上后端」，于是**一个已经成功的删除**
 * 在界面上显示为「后端挂了」。
 */
const NULL_BODY_STATUS = new Set([204, 205, 304])

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

  // **这次请求属于谁**。这就是「用户 ↔ 故事实例」的全部关联逻辑（见文件头那一段）。
  // `/api/*` 上挂着 requireAuth，走到这里 user 必然在；判空是为了**万一有人把这条路由
  // 挪到鉴权之外** —— 那时宁可 401，也不能匿名地落到引擎的缺省属主上（那是所有人共用一个）。
  const user = c.get('user')
  if (!user) return c.json({ error: '需要登录' }, 401)


  // 超时要自己给：fetch 默认没有上界，而引擎那一侧装配一局可能跑上几十秒 —— 不给的话
  // 一个卡住的上游会把这条请求永远挂着，浏览器那边只看到一个转圈的页面。
  // ⚠️ **不能用 `AbortSignal.timeout`**：它一路管到 body 读完，而 SSE 那条流本来就要开着
  // 几十秒到几分钟 —— 用它等于给事件流设了个 30s 的死线，演一轮演到一半流就断。
  // 故这里是**手动计时器**，拿到响应头就清掉：对普通请求它是整体超时，对流式它退化成
  // 「连上之前最多等多久」，那正是这两种形态各自需要的语义。
  const abort = new AbortController()
  // ⚠️ **用一个显式标记判「是不是我们掐的」，别去认异常的 name**：`abort.abort(reason)` 会让
  // fetch 直接以那个 reason 拒绝（name 是 `Error`，不是 `AbortError`），于是超时会被归到
  // 「连不上」那一档 —— 那句话把人径直引向「引擎挂了」，而真相是这次请求太慢。
  let abortedByTimeout = false
  // 「上游到底通没通」—— 拿到响应之后为真。catch 里据它把**本层的 bug** 与「连不上」分开
  let reached = false
  const timer = setTimeout(() => {
    abortedByTimeout = true
    abort.abort()
  }, timeoutFor(rest))
  try {
    const upstream = await fetch(target, {
      method,
      // ⚠️ 写口要把 content-type 带过去：body 原样透传的是字节，缺了这个头
      // FastAPI 会把它当成表单/未知类型，请求体到不了 pydantic 模型那一层。
      headers: {
        // 事件流那条口要的是 text/event-stream；把浏览器的 accept 原样带过去，
        // 其余情况仍旧要 JSON。
        accept: c.req.header('accept') ?? 'application/json',
        // **属主头**：引擎按它分存档目录（`<storage>/<owner>/<save-id>/`），隔离是结构性的。
        // 引擎那侧要显式打开 `GAL_SERVER_TRUST_OWNER_HEADER=true` 才认这个头；没打开时它
        // 恒用缺省属主 —— 那个失败方向是「所有人共用一个属主」，一眼看得出，而不是静默越权。
        [OWNER_HEADER]: user.id,
        // 可选的共享密钥：挡住绕过本服务直连引擎的请求
        ...(galStoryGatewayToken ? { [GATEWAY_TOKEN_HEADER]: galStoryGatewayToken } : {}),
        ...(method === 'GET' || method === 'HEAD'
          ? {}
          : { 'content-type': c.req.header('content-type') ?? 'application/json' }),
      },
      body: method === 'GET' || method === 'HEAD' ? undefined : await c.req.arrayBuffer(),
      signal: abort.signal,
    })

    reached = true
    const contentType = upstream.headers.get('content-type') ?? 'application/json'

    // **SSE 直通，不缓冲**。此前这里是 `await upstream.text()` —— 那会把整条事件流攒到
    // 结束再一次性吐出去，而进度事件的全部意义就是「边跑边看」：一轮几十秒，攒完再给
    // 等于没有进度。故流式响应把 body 原样接出去，并带上那三个头（少了它们，链路上任何
    // 一层反代都可能重新把它缓冲起来，症状与这里缓冲一模一样）。
    if (contentType.includes('text/event-stream')) {
      clearTimeout(timer)
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'content-type': contentType,
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
      })
    }

    // ⚠️ **204 / 205 / 304 不许带 body**：`new Response('', { status: 204 })` 在 undici 上
    // 直接抛 `TypeError`，而那个异常会被下面的 catch 接住、报成「连不上后端」—— 于是
    // **一个已经成功的删除**在界面上显示为「后端挂了」，而存档其实已经没了。判据只有状态码，
    // 与内容无关（`text` 那时本来就是空串），故先分流再读 body。
    if (NULL_BODY_STATUS.has(upstream.status)) {
      return new Response(null, { status: upstream.status })
    }

    // 原样透传状态码与响应体：引擎的 404/409 都带着说人话的 detail（「这一局还没装配——先
    // POST …」），包一层「请求失败」只会把它盖掉。用裸 Response 而不是 c.json：状态码是
    // 上游给的任意值，Hono 那几个辅助方法的类型只认字面量。
    const text = await upstream.text()
    return new Response(text, { status: upstream.status, headers: { 'content-type': contentType } })
  } catch (err) {
    const timedOut =
      abortedByTimeout || (err instanceof Error && err.name === 'TimeoutError')

    // ⚠️ **拿到过响应就说明上游是通的** —— 那这次异常是**本层**出的（响应装配、读 body…），
    // 不能报成「连不上」。这条不是洁癖：上面那个 204 的坑正是这么藏了一整轮 —— 删除明明成功了，
    // 界面却说后端挂了，而人会去重启引擎。误诊比不诊贵，因为它把人引向另一个方向。
    if (reached && !timedOut) {
      return c.json(
        {
          error: `GalStory 代理处理响应时出错（${method} ${rest}）`,
          hint: err instanceof Error ? err.message : String(err),
        },
        500,
      )
    }

    return c.json(
      {
        error: timedOut
          ? `GalStory 后端 ${timeoutFor(rest)}ms 没有响应（${method} ${rest}）`
          : `连不上 GalStory 后端（${galStoryApiUrl}）`,
        hint: timedOut ? undefined : '确认 `gal-story serve` 起着，且 GAL_STORY_API_URL 指对了',
      },
      502,
    )
  } finally {
    clearTimeout(timer)
  }
})

export { galstory }
