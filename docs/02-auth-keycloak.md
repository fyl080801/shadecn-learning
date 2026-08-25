# REQ-AUTH 单点登录、多登录方式与会话

## 1. 目标

接入外部身份提供方（**Keycloak** 与 **GitHub**）做登录，采用 **BFF（Backend for Frontend）** 模式：

- 浏览器**永远拿不到** access_token / refresh_token / id_token，只有一个 httpOnly 的会话 Cookie；
- 授权码换 token、刷新、注销全部在服务端完成，token 落在服务端数据库；
- 不引入 `jose` / `openid-client` 等 OIDC 库，用 Node 标准库 `crypto` 自己实现（这是本需求的验证点之一）。
- **一个用户可以绑多种登录方式**，用其中任意一种都登进同一个账号；在设置页里关联和解绑，至少保留一种（§3.9）。
- **登出只退本站**：清掉本地会话就结束，不去结束 Keycloak 上的 SSO 会话（§3.2.3）。

## 2. 流程需求

下面画的是 Keycloak 那条路。GitHub 走的是**同一个形状**，只是把
「验 id_token」换成「拿 access_token 再调一次 `/user`」（§3.2.2）。

```
浏览器                     Node/Hono                      Keycloak
  │  GET /（未登录）────────►│ 页面闸门：没有会话
  │  ◄── 302 /login ─────────│
  │  GET /login ────────────►│ 发 login.html（前端的第二个入口，不是 SPA）
  │  点「使用 Keycloak 登录」
  │  GET /api/auth/login ────►│
  │                           │ 生成 state / nonce / PKCE verifier
  │                           │ 落库 AuthRequest，id 写进 oidc_tx cookie
  │  ◄── 302 authorize ───────│
  │  ───────────────────────────────────────────────────►│ 登录页
  │  ◄── 302 /api/auth/callback?code&state ──────────────│
  │  GET /api/auth/callback ─►│
  │                           │ 校验 state（一次性消费）
  │                           │ code + code_verifier ───►│ token 端点
  │                           │ ◄── access / refresh / id_token
  │                           │ 用 JWKS 验 id_token 签名、iss、aud、exp、nonce
  │                           │ upsert User，建 Session，写 sid cookie
  │  ◄── 302 回原页面 ─────────│
```

之后**每个**请求（不只是 `/api/*`）：中间件取 `sid` → 查 Session → access_token 快过期就用 refresh_token 续一次 → 把用户挂到 `c.get('user')`。**会话就是被请求本身养活的**：有请求就续期，久到没人发请求了，refresh token 过了 Keycloak 的 SSO Session Idle，才算真的过期。刷新被 Keycloak 明确回绝（4xx，比如 `invalid_grant`）时删除本地会话并清 Cookie，下一跳回登录页。

`/ws/collaboration` 的 WebSocket 握手走同一套：握手本身是普通 HTTP 请求，同源会带 Cookie；校验不过直接回 401 并断开。

**长连接不算「有请求」**：协同连着的那一分钟一次的成员资格复验调的是 `loadSession(token, { refresh: false })` —— 只判此刻有没有效，不续期。否则「会话被请求养活」这条就被一条永不断开的 WebSocket 架空了：挂着画布标签页不动的人永远不会空闲超时。续期由真实请求负责，画布场景下就是编辑触发的那次视图状态 PATCH（见 [REQ-COLLAB](04-realtime-collab.md) 4.2）。

## 3. 功能需求

### 3.1 端点

| 端点 | 行为 |
|---|---|
| `GET /api/auth/config` | 公开配置：`{ enabled, provider, providers, issuer, clientId, loginUrl, logoutUrl }`。`providers` 是当前**配齐了的**登录方式（`{id, label, buttonLabel}`），登录页和设置页都读它；`provider` 是不带 `?provider=` 时的默认那个 |
| `GET /api/auth/me` | **永远返回 200**，body 为 `{ enabled, authenticated, user, expiresAt }`。这样路由守卫不需要错误分支 |
| `GET /api/auth/login` | 生成 state/nonce/PKCE，302 到提供方的授权页。`?provider=` 指定走哪个，不给就是第一个配齐的（有 Keycloak 时就是 Keycloak，老链接行为不变） |
| `GET /api/auth/link/:provider` | **已登录**用户关联一条新的登录方式。和登录同一套授权流程，只是授权请求上多带一个 `linkUserId`。未登录 401，没这个提供方 404 |
| `GET /api/auth/callback` | **只有这一个回调地址**，靠 `AuthRequest.provider` 分发。消费 state、换 token、读身份，然后建会话（登录）或**落一条待确认的关联**（关联，见 §3.9.2） |
| `GET /api/auth/identities` | 当前用户绑了哪些登录方式，外加 `pending`：有没有一条在等确认 |
| `POST /api/auth/link/confirm` | 确认那条待关联 —— **到这一步才真的写库**。没有待确认的 404，超时 410，局面变了 409 |
| `DELETE /api/auth/link/pending` | 放弃那条待关联 |
| `DELETE /api/auth/identities/:id` | 解绑。最后一条 **409**，不是自己的 404 |
| `GET /api/auth/logout` | **只销毁本地会话**（不撤销 refresh_token、不跳 Keycloak 的 end_session）；`?redirect=` 是「退出时人在哪」，会接到登录页的 `?redirect=` 上一起带走（不给就是干净的 `/login`） |

| `GET /login` | 登录页（**前端的第二个入口 `login.html`**，不是 SPA 路由，见 §3.1.2）；已登录则 302 回 `?redirect=` |
| `GET /auth/login-done` | 登录窗口的终点站：同样是服务端渲染的自包含 HTML，只 `postMessage` 一条同源消息告诉开它的那一页「登录好了」，然后把自己关掉。挂在页面闸门**之后**，所以没登录成功就还是被送回 `/login` |

`/api/auth/*` 与 `/api/health` 属于公开路径，其余 `/api/*` 一律经过登录校验。

### 3.1.1 页面闸门（非 `/api` 的请求）

登录校验必须在 **Node 中间件**里完成，不能依赖前端路由守卫。它守的是
**「未登录看不到界面」**，而不是「未登录拿不到字节」：

- 未登录且是整页导航（`Sec-Fetch-Mode: navigate` 或 `Accept: text/html`）→ **302** 到
  `/login?redirect=<原地址>`；`/login`、`/favicon.ico`、`/vite.svg` 例外；
- 未登录的其它请求（`/assets/*.js`、`/assets/*.css`、dev 下的 `/src/**`、`/@vite/*`）→ **放行**；
- `/api/*` 不走这道闸门，仍然按 JSON 401 处理（前端 `apiFetch` 靠它判断会话失效）。

**为什么静态资源要放行**：登录页本身就是前端 bundle 的一个入口
（`login.html`，见 §3.1.2），把资源一起挡掉，登录页自己就白屏了。

**为什么放行了仍然看不到界面**：起 SPA 要 `index.html`，而取它是一次整页导航，
被上面第一条挡在登录页外面。光有 bundle 渲染不出任何东西。

### 3.1.2 登录页是前端的第二个入口

`login.html` + `src/login/`，和 `index.html` 在 `vite.config.ts` 里并列成两个 Vite 入口
（MPA）。SPA 路由表里**没有** `/login` —— 它和应用是并列关系，不是从属关系，
因为未登录时 `index.html` 根本发不出去，登录页不能长在需要它才能启动的那棵树上。

`/login` 的服务端职责只剩一条：**已登录就 302 回 `?redirect=`**（站内校验走 `safeRedirect`）。
页面本体由前端层发（dev 的 Vite 中间件 / prod 的静态目录），页面要的三样东西都自取：

| 要什么 | 从哪来 |
|---|---|
| 有哪些登录方式 | `GET /api/auth/config`（公开端点，匿名可读） |
| 登完回哪儿 | `?redirect=`，原样透传给 `/api/auth/login`，**由服务端做站内校验**，前端不重复实现 |
| 失败原因 | `?error=`，文本插值渲染，转义交给框架 |

这么做是为了**消掉重复**：它以前是服务端拼的 HTML 字符串，配色、图标都得手抄一份，
而深色调色板真的漂过一次（`--primary` 一边 `0.985` 一边 `0.922`）。现在配色直接来自
`@/style.css`、组件直接用 shadcn 的 `Button` / `Card`，两个入口共享同一批 chunk，零重复。

代价也记下来：登录页从「5.3KB 自包含 HTML、零 JS」变成「~62KB gzip、要跑 JS 才渲染」，
其中大头是和应用共享的那份 Tailwind CSS（约 20KB gzip，登录后进应用直接命中缓存）。

### 3.2 身份提供方

两家的差别全部收在 `server/auth/providers/` 的实现里，一个统一接口
（`authorizationUrl` / `exchange` / `refresh`）对外。路由、会话、登录页都**不认识**具体是谁 ——
加一个登录方式 = 新写一个实现 + 在注册表数组里加一行。

**回调只有一个地址**（`$APP_ORIGIN/api/auth/callback`），靠 `AuthRequest.provider` 分发。
这样多接一个提供方不需要去 Keycloak 那边再注册一个回调地址。

#### 3.2.1 Keycloak（OIDC）

- **端点发现**：所有端点从 `$KEYCLOAK_ISSUER/.well-known/openid-configuration` 拉取，**禁止硬编码**。发现结果缓存 10 分钟。
- **PKCE**：`code_challenge_method=S256`，`code_verifier` 不出服务端。confidential client 也要带。
- **id_token 校验**：用 JWKS 验签（支持 RS/PS/ES 系列），kid 未命中时允许重取一次 JWKS；随后校验 `iss` / `aud` / `azp` / `exp` / `iat` / `nonce`。
- **角色的唯一来源**（见 §3.5）。access_token 快过期时用 refresh_token 续期。

#### 3.2.2 GitHub（OAuth2）

GitHub 不是 OIDC，四个差别决定了它必须是独立实现，不能套用上面那套：

1. **没有 discovery**，三个端点写死（GitHub 不提供 well-known 文档）；
2. **没有 id_token**，「这个人是谁」要拿 access_token 再调一次 `/user` —— 没有签名可验，
   但 token 是我们自己从 TLS 通道换回来的，验签本来也只是防配置串台；
   `/user` 的 `email` 为 null（用户把邮箱设为私密）时再去 `/user/emails` 取 primary+verified 的那个，
   拿不到就空着，**邮箱不是必填项**；
3. **换 token 失败也返回 HTTP 200**，错误在 body 里（`{error, error_description}`）——
   只看状态码会把「code 已经用过了」当成功；
4. **OAuth App 的 token 不会过期，也没有 refresh_token** —— 所以它没有续期这回事，
   建会话时 `expiresAt` 直接给 `SESSION_TTL`，会话由本地 TTL 收口而不是由对方收口。
   `Session.provider` 就是为此存在：续期得先知道该问谁。
5. **PKCE 不支持**，传了 `code_challenge` 也会被忽略；防重放靠 state 一次性消费。

GitHub 上没有本应用的角色概念，用它登录拿到的 roles 恒为空数组。

#### 3.2.3 登出：只退本站

清掉本地会话就结束 —— **不撤销 refresh_token，也不跳 Keycloak 的 RP-initiated logout**。
理由是这套系统只是 Keycloak 上的一个应用：从这里退出不该顺手把用户在同一个 SSO 下
别的应用也踢下线。

代价是明确的、也是接受了的：Keycloak 的 SSO Cookie 还在，退出后紧接着再点
「使用 Keycloak 登录」会被静默送回同一个账号，**看起来像没退出去**。
真要换账号，得去 Keycloak 自己的账号中心退，或者用另一种登录方式登进来。

### 3.3 会话

- Cookie `sid` 中存放 32 字节随机 token；数据库主键存的是 `HMAC-SHA256(SESSION_SECRET, token)`。**拖库拿不到可用 Cookie。**
- Cookie 属性：`httpOnly` + `SameSite=Lax`（生产环境需 `Secure`）。
- 读取会话时，若 access_token 距过期不足 30 秒则自动刷新；同一会话的并发刷新通过进程内 promise map 去重，只发一次刷新请求。
- **刷新失败要分两种，混为一谈会把人无故踢下线：**
  - Keycloak 用 4xx 明确回绝（`invalid_grant` —— 用户登出 / SSO 会话超时 / 被踢）：凭证真没了，销毁会话并清 Cookie。
  - 连不上、超时、对方 5xx，或本地写库失败：什么都没证明，**保留会话**，交给下一个请求重试；同时该会话进入 15 秒冷却，免得 Keycloak 挂着时每个请求都去撞一次超时。出站请求一律带 8 秒超时（node 的 fetch 默认不超时）。
- 会话什么时候算过期，由 refresh token 的有效期（Keycloak 的 SSO Session Idle）决定，本地就能判——不必问 Keycloak。`SESSION_TTL`（默认 7 天）只是不让它无限续下去的上限。
- 服务端**每小时**清扫一次过期会话、未被消费的 AuthRequest、以及没人确认的 PendingLink。

### 3.4 授权请求防重放

- `state` / `nonce` / `code_verifier` 存在 `AuthRequest` 表中，由一个短生命周期的 `oidc_tx` Cookie 关联。
- 同一行上还记着 `provider`（回调靠它分发）和 `linkUserId`（有值就是关联而不是登录）。
- 回调时**一次性消费**：同一个 `state` 重放第二次必须失败。

### 3.5 角色

- **只有 Keycloak 给得出角色**：realm 角色（`realm_access.roles`）原样写入 `User.roles`，
  client 角色（`resource_access.<clientId>.roles`）加 `clientId:` 前缀后写入。
- 因此 **`User.roles` 只在 Keycloak 登录时被改写**。用 GitHub 登录拿到的是空数组，
  照写就等于每次用 GitHub 登一次就把这个人的角色清空一次。
- 后端用 `requireRole('admin')` 卡接口（403），前端用 `useAuth().hasRole('admin')` 控制展示。

### 3.5.1 登录后的档案补齐（默认头像）

登录成功之后，用户档案里空着的字段由一层**补齐钩子**填上。这层挂在 `upsertUser` **外面**：
`upsertUser` 只负责把 id_token 的 claims 落库，「还该给这个人补点什么」是另一件事，
以后再加规则（默认显示名、默认时区……）不该往登录流程里堆。

- 机制在 `server/auth/profile.ts`：`registerProfileHook()` 挂规则，`completeUserProfile(user)`
  在登录回调里跑一遍。钩子只回答「缺什么」，合并成一次 update；某条钩子抛异常只记日志，**不能挡住登录**。
- **每次登录都跑**，所以存量用户下次进来自动补齐 —— 不需要迁移脚本，读取侧也不用到处兜底。
- 当前只有一条规则（`server/avatar/`）：**没有头像的用户补一张 identicon** ——
  GitHub 那种由身份算出来的像素方块，用 [minidenticons](https://github.com/laurentpayot/minidenticons)（MIT）生成 SVG。
  Keycloak 给了 `picture` 就用人家的，这条规则只管空着的。
- 头像**不落图片**：库里存的是 `/api/avatars/<seed>.svg`，请求进来现算。
  `seed = sha256(issuer + "\n" + subject)` 取前 16 位十六进制 —— 用 `(issuer, subject)` 而不是 `user.id`，
  重建库之后头像还是原来那张；取哈希是为了不把 subject 明文挂在图片地址上。
- `GET /api/avatars/:seed` 无数据库读写、不认请求者，按不可变资源缓存（`max-age=31536000, immutable`）；
  种子形状不对一律 404。它和其它 `/api/*` 一样要求登录。
- 没配 Keycloak 的本地模式，那个固定的开发用户走同一条补齐路径。
- 界面上凡是显示头像的地方都垫一层圆形底色（identicon 是透明底的图案）：
  侧边栏用户区、设置页、项目成员列表、协同在场头像。

### 3.6 回跳地址安全

- `?redirect=` 只允许**站内路径**。
- `//evil.com`、`/\evil.com` 这类协议相对 / 反斜杠绕过必须被识别并回退到 `/`。

### 3.7 前端契约

`src/lib/auth.ts` 对外提供：

| 导出 | 说明 |
|---|---|
| `fetchSession()` | 请求一次 `/api/auth/me` 并缓存结果 |
| `useAuth()` | `user` / `roles` / `isAuthenticated` / `authEnabled` / `sessionExpired` / `hasRole` / `displayName` / `startLogin` / `startLogout` |
| `apiFetch()` | 带凭据的 fetch 封装，遇 401 调 `requestReLogin()`（**不直接跳**） |
| `requestReLogin(redirect)` | 记下 return url、把提示打开；**不跳转** |
| `logoutFromExpired()` | 「退出」：整页跳 `/api/auth/logout?redirect=<return url>` |
| `openLoginWindow()` / `loginWindowUrl()` / `isLoginDone()` / `finishReLogin()` | 「重新登录」那条路：开登录窗口、窗口的地址、校验完成消息、确认真登上了 |
| `dismissReLogin()` | 关掉、什么都不做 |
| `goToLoginPage()` | 整页 `location.replace` 到服务端渲染的 `/login` |

- 登录 / 登出是**整页跳转**到 `/api/auth/login`、`/api/auth/logout`，不是 XHR。
- 登录页由服务端渲染，SPA 路由表里**没有** `/login`，也没有对应的 Vue 组件。
- **会话过期要有反馈，且怎么走由用户决定**：接口拿到 401 时只把 `sessionExpired` 置上，
  由 `App.vue` 里挂一次的 `SessionExpiredDialog` 弹出来。两个出口，外加随时可以关掉：

  | 选择 | 行为 |
  |---|---|
  | 退出 | 整页跳 `/api/auth/logout?redirect=<过期时的地址>` → 清本地会话 → 落回 `/login?redirect=<原地址>`，重新登录完回到原来那一页 |
  | 重新登录 | **不离开当前页**：新开一个窗口走完整套 OIDC（`/api/auth/login?redirect=/auth/login-done`），登录成功后提示自己关掉，页面和没提交的内容全在 |
  | 关掉（× / Esc / 点遮罩） | 什么都不做；之后再有 401 会再问一遍 |

  悄悄整页跳走既会带走用户正在填的东西，也让人看不出发生了什么。
- **为什么是新窗口而不是模态里的 iframe**：iframe 能不能显示取决于 Keycloak——默认的
  `X-Frame-Options: SAMEORIGIN` 会让模态里一片空白，还得去改 realm 的 Security defenses；
  而且浏览器的第三方 Cookie 限制会挡住 iframe 里 Keycloak 自己的 SSO Cookie，每次都得重输密码。
  新窗口是**顶层浏览上下文**，这两条都不成立：不用配 Keycloak，SSO Cookie 也还是 first-party，
  常常点一下就登回来了。代价是可能被浏览器的弹窗拦截器拦下——`window.open()` 返回 `null` 时
  提示一句、按钮变成「重新打开登录窗口」，提示框本身不关。
- **怎么知道登成功了**：会话是 httpOnly cookie，前端读不到，所以靠两条腿——
  `/auth/login-done` 的 `postMessage`（快，收到的那一页按 `event.origin === location.origin` +
  消息标记两道校验），外加等待期间每 3 秒问一次 `/api/auth/me` 兜底（消息被拦，或 `opener`
  被中间页面切断）。**只有 `/api/auth/me` 真的答「已登录」才收工**，登录失败时提示留着。
  用户把登录窗口关了又没登上，轮询发现 `window.closed` 就停下来，按钮还给他重开一次。
- 前端路由守卫只是兜底：正常情况下未登录根本加载不到 SPA，守卫处理的是「用着用着会话过期」。
  首屏导航（`from === START_LOCATION`，页面上本来就没内容）直接整页跳 `/login`；
  已经在应用里再导航时走同一个提示，导航被拦下，人留在当前页。

### 3.8 未配置时的降级

当**一个提供方都没配齐**（Keycloak 缺 issuer/clientId，且 GitHub 缺 clientId/secret）：

- **开发环境**：打印一行告警，全站放行（方便只跑前端 demo），`/api/auth/me` 返回 `enabled: false`；
- **生产环境**（`NODE_ENV=production`）：**拒绝启动**。

「配了一半」（只填了 `KEYCLOAK_ISSUER` 没填 client id、或只填了 `GITHUB_CLIENT_ID` 没填 secret）
按「想配但配漏了」处理，明确报出缺哪个；两个都空才算「这次不用它」。

### 3.9 多登录方式与账号关联

一个用户可以绑多条登录方式，用其中任意一条都登进同一个账号。

**数据模型**（`prisma/models/auth.prisma`、`server/store/identities.ts`）：

- 每条绑定是一行 `UserIdentity`，`(provider, subject)` **唯一** —— 同一个 GitHub 账号
  只能绑给一个人，这条约束就是冲突检测的全部依据。
- 其中一条是**主身份**：`User.issuer` / `User.subject` 那一对值指向的那条。
  主身份没有单独的布尔列，是比出来的 —— 多存一个 `isPrimary` 就多一个可能和 `User` 对不上的地方。
- **用户档案（显示名 / 邮箱 / 头像）只跟主身份走**。用副身份登录一次不该把
  Keycloak 那边的显示名悄悄换掉。
- 存量用户（`UserIdentity` 这张表之前就登录过的人）的主身份**用到的时候补**：
  登录走领养分支，设置页读列表时回填。不写迁移脚本（本仓库没有 migration，见 REQ-DATA §3.4）。

**关联**（`GET /api/auth/link/:provider`）走的是和登录**同一套**授权流程，
区别只有授权请求上的 `linkUserId` —— 回调据此决定是建会话还是绑一条身份。
三种拒绝要分开说，因为给用户的话完全不同：

| 情况 | 提示 |
|---|---|
| 这个第三方账号已经绑在自己身上 | 「已经关联过了」 |
| 自己已经绑了这个提供方的另一个账号 | 「请先解绑它」——**一个提供方只留一条**，否则「解绑哪一个」「主身份是哪个」都要解释 |
| 这个第三方账号绑在别人身上 | 「请先用它登录并解绑」 |

**解绑**（`DELETE /api/auth/identities/:id`）：

- **最后一条不许解**（409）。解掉了这个人就再也登不进来，而这里**没有**邮箱找回这种兜底，
  账号连同它名下的项目一起变成孤儿。前端也会把按钮禁掉，但判定必须在服务端。
- 解掉的是主身份时，剩下的第一条被提升上来（改写 `User.issuer` / `subject`），
  但**不改显示名和头像** —— 换一种登录方式不该让别人看到的你变个样。
- **当前会话不受影响**：会话是我们自己发的，不是提供方发的。

**界面**在设置页的「登录方式」卡片（`src/components/settings/LinkedAccounts.vue`）。
关联是**整页跳转**而不是 XHR（要经过第三方的授权页，和登录、登出同一个道理）；
跳回来时结果挂在 query 上（`?linked=` / `?link_error=`），读一次、弹个 toast、
然后把 query 洗掉 —— 留着的话刷新一次会再提示一遍。

#### 3.9.1 身份只认 `(provider, subject)`，不按邮箱自动认定

**「两条绑定的邮箱一样，所以是同一个人」这个推断一条都不做**，哪怕提供方明说
那个邮箱已验证。默认立场是「不同的人」；合并只发生在**有人拿目标账号自己的凭据
证明过自己**的时候 —— 也就是先登录进去，再从设置页点「关联」（上面那一段）。

三个理由，按重要性：

1. **手动关联里的那个会话本身就是最强的证明**，强过任何从邮箱推出来的结论，
   而且不需要信任任何第三方。能走这条路的场景就不该引入邮箱推断。
2. **邮箱是属性不是标识。** 它会变、注销后会被回收再分配（Google Workspace 的员工
   离职就是这样）、Sign in with Apple 还会逐应用发不同的私有转发地址。各家 IdP 的
   文档都写着「用 `sub` 不要用 `email`」，正是因为拿它当 key 迟早出事。
3. **自动合号是账号接管的经典入口。** 判定里「正在登录的这个人真的控制这个邮箱」
   这句话只能由来源 IdP 断言，我们无从复核；一旦某个 IdP 的验证不严，或者管理员能
   直接把 `email_verified` 置成 true（Keycloak 就可以），它就变成一条登进别人账号的路。

一个直接的实现后果：**GitHub 只在 `/user` 没给邮箱时才去要 `/user/emails`**。
邮箱在这里只是档案字段，不值得为它每次登录都多一个往返。

**代价是明确的、也是接受了的**：同一个人先用 Keycloak、后用 GitHub 登录会得到
**两个**账号。正确姿势是先用主账号登录再去关联 —— 别反过来。

#### 3.9.2 关联必须由用户确认一次

第三方授权回来之后**不直接落库**：先把结果暂存成一条 `PendingLink`，回到设置页
弹确认框，把「你要关联的是 **@octocat**（octo@example.com）」摆到眼前，点了才写。

**为什么非要多这一步。** 关联的入口在设置页，看起来「你已经登录着，所以是你本人」
就够了。但走出去那一趟不是：提供方那边**可能正登着别人的账号**（共用电脑最典型），
而 OAuth App 一旦被授权过，之后连确认页都不会再弹 —— 点一下「关联」，浏览器
一来一回就回来了，用户全程没被问过任何东西。这时候如果直接写库，绑上的就是
**那个人的**第三方账号，而后果是他从此可以登录你的账号。

更麻烦的是 GitHub **没有账号选择器**（不像 Google 的 `prompt=select_account`），
authorize 端点只接受一个 `login=` 做建议；真要换号得先去 github.com 登出。
所以「这到底绑的是谁」这句话，没有别人会问，只能我们问。

几条实现约束：

- **一个人同时只有一条待确认**（`PendingLink.userId` 唯一），再发起一次顶掉旧的 ——
  否则「确认框里显示的是哪一次的结果」会变成一个需要解释的问题。
- **不存 access token**：确认时用不到，给一条还没被认可的绑定存凭证是白担风险。
- **回调那一步只做预检**（`identities.checkLink`，只读）：已经绑过、被别人占了这类
  注定失败的情况不该先弹一个点了也没用的框。真正的判定在确认时重做一遍 ——
  预检和确认之间隔着用户思考的时间，那条身份完全可能已经被别人绑走。
- **待确认状态挂在 `GET /api/auth/identities` 的响应里，不挂在 URL 上**。这样用户
  中途关了标签页再回到设置页，确认框照样出现，不会留下一条谁也想不起来的半截绑定。
- **确认走 POST**（`/api/auth/link/confirm`）：状态变更，且必须不能由一条链接触发。
- 确认框**可以直接关掉**（Esc），那是合法的第三条路 ——「等会儿再说」。什么都没绑，
  下次进设置页会再问一遍。要守的是「不确认就不写库」，那一条在服务端，不靠不许关窗。
- 10 分钟没人理就过期；读取时顺手删，`sweepExpired()` 兜底。

#### 3.9.3 没有账号合并

承上：已经分叉的两个号**并不到一起去**。先用 GitHub 建了号 B、之后又用 Keycloak
建了号 A，B 想并进 A 只能先在 B 里把 GitHub 解绑，但那是 B 的最后一条，解不了。见 §6。

## 4. 配置需求

### 4.1 Keycloak 侧

在目标 realm 建一个 client：

| 项 | 值 |
|---|---|
| Client ID | `shadcn-learning`（与 `KEYCLOAK_CLIENT_ID` 一致） |
| Client authentication | 建议 **On**（confidential，secret 填进 `KEYCLOAK_CLIENT_SECRET`）；Off 也支持，走纯 PKCE |
| Standard flow | 开 |
| Direct access grants / Service accounts | 关 |
| Valid redirect URIs | `http://127.0.0.1:3000/api/auth/callback`，线上再加 `https://<域名>/api/auth/callback` |
| Valid post logout redirect URIs | **不用配**：登出只退本站，不走 RP-initiated logout（§3.2.3） |
| Web origins | 同源部署填 `+` |
| PKCE | Advanced → Proof Key for Code Exchange 设为 `S256`（留空也能跑） |

「重新登录」走的是新窗口，是顶层浏览上下文，**Keycloak 侧不需要为它另外配什么**——
既不用动 Security defenses 里的 `X-Frame-Options` / `frame-ancestors`（那是 iframe 才有的问题），
Keycloak 自己的 SSO Cookie 也还是 first-party，往往连密码都不用重输。

### 4.1.1 GitHub 侧

<https://github.com/settings/developers> → **New OAuth App**：

| 项 | 值 |
|---|---|
| Homepage URL | `$APP_ORIGIN` |
| Authorization callback URL | `$APP_ORIGIN/api/auth/callback` —— **和 Keycloak 共用同一个回调**，不是另一个地址 |
| Client secret | 必须生成。GitHub 的 OAuth App 一定是 confidential client，没有 secret 换不了 token |

GitHub App（不是 OAuth App）也能跑，但它发的 token 会过期、带 refresh_token，
和这里「token 不过期、没有续期」的实现对不上，要用得先补一条续期实现。

### 4.2 环境变量

至少配齐 Keycloak 或 GitHub 其中一组；两组都配就是两个登录入口。

| 变量 | 说明 |
|---|---|
| `KEYCLOAK_ISSUER` | `{keycloak}/realms/{realm}`，端点靠 discovery 自动发现 |
| `KEYCLOAK_CLIENT_ID` | client id |
| `KEYCLOAK_CLIENT_SECRET` | confidential client 的密钥；public client 留空 |
| `KEYCLOAK_SCOPE` | 默认 `openid profile email` |
| `GITHUB_CLIENT_ID` | OAuth App 的 client id |
| `GITHUB_CLIENT_SECRET` | OAuth App 的 client secret，**必填**（没有它换不了 token） |
| `GITHUB_SCOPE` | 默认 `read:user user:email`，只读身份 |
| `APP_ORIGIN` | 应用对外地址，`redirect_uri` 由它拼出，必须与 Keycloak 配置一致 |
| `SESSION_SECRET` | 会话 token 的 HMAC 密钥，生产必须是随机串（`openssl rand -hex 32`） |
| `SESSION_TTL` | 会话最长存活秒数，默认 604800（7 天） |

数据库相关变量见 [REQ-DATA](05-data-persistence.md)。

### 4.3 本地跑通

```bash
cp .env.example .env      # 改成自己的 Keycloak
pnpm install              # postinstall 会跑 prisma generate
pnpm db:push              # 建 data/app.db（db push，无迁移文件）
pnpm dev                  # http://127.0.0.1:3000
```

## 5. 验收标准

- [ ] 完整走通登录 → 访问受保护页面 → 登出 → 再访问受保护页面被弹回登录页。
- [ ] 未登录时 `curl -H 'accept: text/html' /` 返回 302 到 `/login?redirect=%2F`；
      对 `/projects`、`/flows/x` 等任意应用页同理 —— **界面看不到**。
- [ ] 未登录时 `curl /assets/*.js`、`curl /src/main.ts` **返回 200**（静态资源放行），
      但这不足以渲染出任何界面，因为拿不到 `index.html`。
- [ ] `/login` 匿名可访问，发的是 `login.html`（引用 `/assets/login-*.js`），
      不是 `index.html`；已登录访问 `/login` 则 302 回 `?redirect=`，站外地址回落到 `/`。
- [ ] 浏览器 DevTools 中除 `sid` / `oidc_tx` 外看不到任何 token；`sid` 为 httpOnly。
- [ ] 同一个 `state` 重放回调必须失败。
- [ ] `?redirect=//evil.com`、`?redirect=/\evil.com` 都回退到 `/`。
- [ ] access_token 过期后继续操作可自动续期，用户无感知。
- [ ] Keycloak 侧强制下线后，前端下一次请求被弹回登录页。
- [ ] 未登录发起 `/ws/collaboration` 握手返回 401 并断开。
- [ ] 一个提供方都不配时：dev 全站放行；`NODE_ENV=production` 启动失败并给出明确报错。
- [ ] 两个提供方都配上后，登录页并排出现两个按钮；只配一个时只出现那一个。
- [ ] 用 GitHub 首次登录会建号；同一个 GitHub 账号再登还是同一个人，不会建出第二个号。
- [ ] 登出后 `location` 是站内的 `/login`，**不含** Keycloak 的 end_session 地址，整个登出过程零出站请求。
- [ ] 已登录用户在设置页点「关联 GitHub」→ 走完授权 → 回到设置页**先弹确认框**，
      上面写着即将关联的 GitHub 用户名和邮箱；此时列表里还没有第二条。
- [ ] 点「确认关联」后列表才出现第二条，会话没换；点「不是我，取消」则什么都不发生。
- [ ] 确认框期间关掉标签页，再回到设置页，确认框**仍然会出现**（状态在服务端不在 URL）。
- [ ] 别人的待确认关联，用自己的会话去 `POST /api/auth/link/confirm` 拿到 404。
- [ ] 用已被别人绑走的 GitHub 账号去关联 → 回设置页报错，那条绑定仍属于原主人。
- [ ] 只剩一条登录方式时，解绑按钮是禁用的；直接调 `DELETE /api/auth/identities/:id` 返回 409。
- [ ] 解绑主身份后另一条被提升为主身份，显示名和头像不变，当前会话仍然有效。
- [ ] 用 GitHub 登录不会清掉 Keycloak 那边同步过来的角色。
- [ ] 邮箱相同的两次登录（Keycloak 一次、GitHub 一次）得到**两个独立账号**，
      已有账号身上不会多出一条绑定 —— 身份只认 `(provider, subject)`。
- [ ] Keycloak 没给 `picture` 的用户，登录后 `/api/auth/me` 里带着 `/api/avatars/<seed>.svg`，界面上能看到头像；
      给了 `picture` 的不被覆盖；同一个人每次登录都是同一张图。

## 6. 本期不做

- 本地用户名 / 密码登录、注册、找回密码。
- 记住我 / 长期免登录。
- 更多身份源（微信、Google 等）—— 机制已经是注册表，加一个是新写一个实现 + 加一行。
- **账号合并**：两个已经存在的本地用户没法并成一个（§3.9.3）。要合并得先想清楚
  项目归属、个人空间、协同在场这些东西怎么并，不是一个 `UPDATE` 的事。
- **撞邮箱时的引导**：现在是静默地各建各的号，没有「这个邮箱已经注册过了，
  请先用它登录再来关联」这类提示 —— 提示本身要小心，它会泄露「某个邮箱在本站注册过」。
- **绑定前重新认证**（`prompt=login` / `max_age=0`）：被盗的会话现在可以悄悄绑上
  攻击者的第三方账号，变成一个改密码也踢不掉的后门。
- **绑定成功后的通知邮件**、以及**绑定时作废该用户其它会话**：前者是唯一的事后检测
  手段，后者防的是「攻击者先挂着会话、等你把身份绑进来」那一类。三条都要等邮件能力。
- **同一个提供方绑多个账号**：一个提供方只留一条。
- **管理员的用户管理页**（看所有用户 / 改角色 / 禁用）：设置页只管当前用户自己。
- 「切换账号」入口（强制 `prompt=login` 重新输密码）：登出只退本站，换账号得去 Keycloak 自己那边退。
- 细粒度权限（资源级 ACL）；只有角色级别。
- 前端 token 静默刷新（token 根本不在前端）。

## 7. 待确认事项

- 生产环境 Cookie 是否统一强制 `Secure`（当前依赖部署在 HTTPS 后）。
- 会话数量上限 / 单用户并发会话是否需要限制。
- 角色变更后何时生效——目前角色在登录时快照进 `User.roles`，刷新 token 时是否要同步更新。
