# REQ-AUTH Keycloak 单点登录与会话

## 1. 目标

接入 Keycloak 作为唯一身份源，采用 **BFF（Backend for Frontend）** 模式：

- 浏览器**永远拿不到** access_token / refresh_token / id_token，只有一个 httpOnly 的会话 Cookie；
- 授权码换 token、刷新、注销全部在服务端完成，token 落在服务端 SQLite；
- 不引入 `jose` / `openid-client` 等 OIDC 库，用 Node 标准库 `crypto` 自己实现（这是本需求的验证点之一）。

## 2. 流程需求

```
浏览器                     Node/Hono                      Keycloak
  │  GET /（未登录）────────►│ 页面闸门：没有会话
  │  ◄── 302 /login ─────────│
  │  GET /login ────────────►│ 服务端模板渲染登录页（不加载前端 bundle）
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

`/ws/*` 的 WebSocket 握手走同一套：握手本身是普通 HTTP 请求，同源会带 Cookie；校验不过直接回 401 并断开。

## 3. 功能需求

### 3.1 端点

| 端点 | 行为 |
|---|---|
| `GET /api/auth/config` | 公开配置：`{ enabled, provider, issuer, clientId, loginUrl, logoutUrl }`；未启用时 issuer/clientId 为 null |
| `GET /api/auth/me` | **永远返回 200**，body 为 `{ enabled, authenticated, user, expiresAt }`。这样路由守卫不需要错误分支 |
| `GET /api/auth/login` | 生成 state/nonce/PKCE，302 到 Keycloak authorize |
| `GET /api/auth/callback` | 消费 state、换 token、验 id_token、建会话、302 回原页面 |
| `GET /api/auth/logout` | 销毁本地会话、撤销 refresh_token，并跳 Keycloak RP-initiated logout |

| `GET /login` | **服务端模板渲染**的登录页（不是 SPA 路由）；带 `?redirect=` / `?error=`；已登录则 302 回 redirect |

`/api/auth/*` 与 `/api/health` 属于公开路径，其余 `/api/*` 一律经过登录校验。

### 3.1.1 页面闸门（非 `/api` 的请求）

登录校验必须在 **Node 中间件**里完成，不能依赖前端路由守卫 —— 未登录的浏览器不应该拿到任何前端产物：

- 除 `/login`、`/favicon.ico`、`/vite.svg` 外，所有非 `/api` 请求都要有会话；
- 未登录且是整页导航（`Sec-Fetch-Mode: navigate` 或 `Accept: text/html`）→ **302** 到 `/login?redirect=<原地址>`；
- 未登录的其它请求（`/assets/*.js`、dev 下的 `/src/**`、`/@vite/*`、XHR）→ **401**，绝不回 HTML；
- `/api/*` 不走这道闸门，仍然按 JSON 401 处理（前端 `apiFetch` 靠它判断会话失效）。

因此 `index.html` 与整个 SPA bundle 只会发给已登录的会话，禁用 JS 或直接 `curl` 也绕不过去。

### 3.2 OIDC 对接

- **端点发现**：所有端点从 `$KEYCLOAK_ISSUER/.well-known/openid-configuration` 拉取，**禁止硬编码**。发现结果缓存 10 分钟。
- **PKCE**：`code_challenge_method=S256`，`code_verifier` 不出服务端。confidential client 也要带。
- **id_token 校验**：用 JWKS 验签（支持 RS/PS/ES 系列），kid 未命中时允许重取一次 JWKS；随后校验 `iss` / `aud` / `azp` / `exp` / `iat` / `nonce`。
- **注销**：调用 revocation 端点撤销 refresh_token，并走 RP-initiated logout 让 Keycloak 侧会话一并结束。

### 3.3 会话

- Cookie `sid` 中存放 32 字节随机 token；数据库主键存的是 `HMAC-SHA256(SESSION_SECRET, token)`。**拖库拿不到可用 Cookie。**
- Cookie 属性：`httpOnly` + `SameSite=Lax`（生产环境需 `Secure`）。
- 读取会话时，若 access_token 距过期不足 30 秒则自动刷新；同一会话的并发刷新通过进程内 promise map 去重，只发一次刷新请求。
- **刷新失败要分两种，混为一谈会把人无故踢下线：**
  - Keycloak 用 4xx 明确回绝（`invalid_grant` —— 用户登出 / SSO 会话超时 / 被踢）：凭证真没了，销毁会话并清 Cookie。
  - 连不上、超时、对方 5xx，或本地写库失败：什么都没证明，**保留会话**，交给下一个请求重试；同时该会话进入 15 秒冷却，免得 Keycloak 挂着时每个请求都去撞一次超时。出站请求一律带 8 秒超时（node 的 fetch 默认不超时）。
- 会话什么时候算过期，由 refresh token 的有效期（Keycloak 的 SSO Session Idle）决定，本地就能判——不必问 Keycloak。`SESSION_TTL`（默认 7 天）只是不让它无限续下去的上限。
- 服务端**每小时**清扫一次过期会话和未被消费的 AuthRequest。

### 3.4 授权请求防重放

- `state` / `nonce` / `code_verifier` 存在 `AuthRequest` 表中，由一个短生命周期的 `oidc_tx` Cookie 关联。
- 回调时**一次性消费**：同一个 `state` 重放第二次必须失败。

### 3.5 角色

- Keycloak realm 角色（`realm_access.roles`）原样写入 `User.roles`。
- client 角色（`resource_access.<clientId>.roles`）加 `clientId:` 前缀后写入。
- 后端用 `requireRole('admin')` 卡接口（403），前端用 `useAuth().hasRole('admin')` 控制展示。

### 3.6 回跳地址安全

- `?redirect=` 只允许**站内路径**。
- `//evil.com`、`/\evil.com` 这类协议相对 / 反斜杠绕过必须被识别并回退到 `/`。

### 3.7 前端契约

`src/lib/auth.ts` 对外提供：

| 导出 | 说明 |
|---|---|
| `fetchSession()` | 请求一次 `/api/auth/me` 并缓存结果 |
| `useAuth()` | `user` / `roles` / `isAuthenticated` / `authEnabled` / `hasRole` / `displayName` / `startLogin` / `startLogout` |
| `apiFetch()` | 带凭据的 fetch 封装，遇 401 自动进入登录流程 |
| `goToLoginPage()` | 整页 `location.replace` 到服务端渲染的 `/login` |

- 登录 / 登出是**整页跳转**到 `/api/auth/login`、`/api/auth/logout`，不是 XHR。
- 登录页由服务端渲染，SPA 路由表里**没有** `/login`，也没有对应的 Vue 组件。
- 前端路由守卫只是兜底：正常情况下未登录根本加载不到 SPA，守卫处理的是「用着用着会话过期」，此时整页跳 `/login`。

### 3.8 未配置时的降级

当 `KEYCLOAK_ISSUER` 或 `KEYCLOAK_CLIENT_ID` 缺失：

- **开发环境**：打印一行告警，全站放行（方便只跑前端 demo），`/api/auth/me` 返回 `enabled: false`；
- **生产环境**（`NODE_ENV=production`）：**拒绝启动**。

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
| Valid post logout redirect URIs | `http://127.0.0.1:3000/login`，线上同理 |
| Web origins | 同源部署填 `+` |
| PKCE | Advanced → Proof Key for Code Exchange 设为 `S256`（留空也能跑） |

### 4.2 环境变量

| 变量 | 说明 |
|---|---|
| `KEYCLOAK_ISSUER` | `{keycloak}/realms/{realm}`，端点靠 discovery 自动发现 |
| `KEYCLOAK_CLIENT_ID` | client id |
| `KEYCLOAK_CLIENT_SECRET` | confidential client 的密钥；public client 留空 |
| `KEYCLOAK_SCOPE` | 默认 `openid profile email` |
| `APP_ORIGIN` | 应用对外地址，`redirect_uri` 由它拼出，必须与 Keycloak 配置一致 |
| `SESSION_SECRET` | 会话 token 的 HMAC 密钥，生产必须是随机串（`openssl rand -hex 32`） |
| `SESSION_TTL` | 会话最长存活秒数，默认 604800（7 天） |

数据库相关变量见 [REQ-DATA](05-data-persistence.md)。

### 4.3 本地跑通

```bash
cp .env.example .env      # 改成自己的 Keycloak
pnpm install              # postinstall 会跑 prisma generate
pnpm db:migrate           # 建 data/app.db
pnpm dev                  # http://127.0.0.1:3000
```

## 5. 验收标准

- [ ] 完整走通登录 → 访问受保护页面 → 登出 → 再访问受保护页面被弹回登录页。
- [ ] 未登录时 `curl -H 'accept: text/html' /` 返回 302，`curl /assets/*.js`、`curl /src/main.ts` 返回 401 —— 拿不到任何前端产物。
- [ ] `/login` 的响应里没有 `<script>`，不请求 `/api/*`。
- [ ] 浏览器 DevTools 中除 `sid` / `oidc_tx` 外看不到任何 token；`sid` 为 httpOnly。
- [ ] 同一个 `state` 重放回调必须失败。
- [ ] `?redirect=//evil.com`、`?redirect=/\evil.com` 都回退到 `/`。
- [ ] access_token 过期后继续操作可自动续期，用户无感知。
- [ ] Keycloak 侧强制下线后，前端下一次请求被弹回登录页。
- [ ] 未登录发起 `/ws/<room>` 握手返回 401 并断开。
- [ ] 不配 Keycloak 时：dev 全站放行；`NODE_ENV=production` 启动失败并给出明确报错。

## 6. 本期不做

- 本地用户名 / 密码登录、注册、找回密码。
- 记住我 / 长期免登录。
- 多身份源（GitHub、微信等）。
- 细粒度权限（资源级 ACL）；只有角色级别。
- 前端 token 静默刷新（token 根本不在前端）。

## 7. 待确认事项

- 生产环境 Cookie 是否统一强制 `Secure`（当前依赖部署在 HTTPS 后）。
- 会话数量上限 / 单用户并发会话是否需要限制。
- 角色变更后何时生效——目前角色在登录时快照进 `User.roles`，刷新 token 时是否要同步更新。
