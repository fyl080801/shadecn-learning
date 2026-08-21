# REQ-BACKEND 数据访问下沉：Node 不再直连数据库与存储

> 状态：**规划中（设计稿）** —— 尚无实现。本文是一份**接口契约清单**：
> 把当前 Node 侧所有直连持久化的位置盘干净，逐条给出「换成远端后端服务之后，
> 对方必须提供什么方法、什么语义、什么并发保证」。
>
> 前置：[REQ-DATA](05-data-persistence.md)（数据模型）、[REQ-AUTH](02-auth-keycloak.md)（会话）、
> [REQ-COLLAB](04-realtime-collab.md)（Yjs 落库与踢线）、[REQ-SOLO](16-personal-flow.md)（个人画布的 REST 写入）、
> [REQ-CLUSTER](14-clustering.md)（共享协调层）。

## 1. 目标与边界

**目标**：Node 进程退回成「协议层 + 实时层」——它继续负责 HTTP/WebSocket、OIDC、Yjs 合并、
在场与踢人，但**不再持有数据库连接，也不再直接读写任何存储**。所有持久化经由一个远端后端服务。

**这不是一次纯搬迁**。有三件事换成远程调用之后语义会变，必须由后端补上新能力（第 6 节）：
一次鉴权从 3 次本地查询变成 3 次网络往返；一次性消费（`AuthRequest`）从两步变成需要原子接口；
权限撤销的**触发点**会离开 Node，必须有事件通道，否则被移出项目的人还能写满一个复验窗口，
而**其他人撤销不回来**（没有审计表、没有恢复路径，见 [REQ-COLLAB §4.2.1](04-realtime-collab.md)）。

**边界**：本文只定义 Node ↔ 后端之间的方法契约，不规定协议（REST / gRPC / 自定 RPC 都行）、
不规定后端语言、不涉及前端。前端与 `/api/*` 的契约**完全不变**。

## 2. 现状盘点

Node 现在直接碰持久化的只有四类。

| 类别 | 落点 | 代码位置 |
|---|---|---|
| 关系表（7 张） | `User` `Session` `AuthRequest` / `Project` `ProjectMember` `ProjectInvite` / `Flow` `FlowUserState` | `server/store/*`、`server/auth/{session,project,profile}.ts`、`server/routes/auth.ts` |
| Yjs 二进制 | `Flow.ydoc`（bytes）、`Flow.graph`（JSON 投影）、`Flow.revision`（写计数 / CAS 版本号） | `collab/persistence.ts`、`collab/flow-writer.ts` |
| 共享协调状态 | 7 张 `SharedMap` + 1 把 `SharedLock`（内存 or Redis） | `cluster/`，使用方见 §4.6 |
| 文件存储 | **没有**。头像是 identicon 现算现返，不落盘 | `server/avatar/` |

`server/store/notes.ts` 是内存 `Map` 的 API 样板，不在迁移范围内。

### 2.1 按调用频率排序的热路径

下沉之后这几条会从「一次本地查询」变成「一次 RTT」，是整个改造的性能主线：

| 调用 | 触发频率 | 现在的代价 |
|---|---|---|
| `loadSession(token)` | **每个 HTTP 请求 1 次**（`withSession` 挂在 `*` 上，页面守卫也走它） | 1 次查询（含 user） |
| `projects.membershipOf()` | 每个项目 / 画布 API 1 次 | 1 次查询 |
| `authorizeCollab()` | 每次 WS 握手；每 20s × 每房间 × 每个不同 cookie（复验）；每个写帧（10s 判定缓存兜底） | **3 次查询**（会话 → 画布归属 → 成员角色） |
| `flowUserState.patch()` | 每个**正在编辑**的人约 10s 一次（它同时是会话心跳，见 [REQ-SOLO §4.7](16-personal-flow.md)） | 每个 key 一次 upsert |
| `storeFlowState()` | 每房间 2s 防抖 / 10s 上限一次 | 1 次写，负载最大 2MB |
| `applyFlowUpdate()` | 个人画布每次推送（客户端已防抖收敛） | 1 读 + 1 CAS 写 |

## 3. 划界：什么下沉，什么留在 Node

**留在 Node**（后端不用管，也不该管）：

- Yjs 全部运行时行为 —— 合并、状态向量、增量编码、悬空边清理、`UndoManager` 语义；
- Hocuspocus 房间生命周期、awareness、身份改写、单连接互斥、配额度量与 `readOnly` NACK；
- OIDC：PKCE、JWKS、`id_token` 校验、token 交换与刷新（后端只存 token，不去 Keycloak）；
- 会话 cookie 的 HMAC（`SESSION_SECRET` 不出 Node，后端只把 `HMAC(token)` 当主键）；
- **鉴权判定规则**：非成员 404 不 403、个人空间拒协同、personal 项目拒成员管理。
  后端只回**事实**（角色、项目形态），不回 HTTP 语义 —— 否则那条「不泄露存在性」的铁律
  就变成两个系统共同维护的东西。
- identicon 渲染。

**下沉**：第 4 节的全部方法。

**建议不下沉（保留 Redis 直连）**：§4.6 的共享协调层。理由在那一节。

## 4. 接口清单

签名用 TypeScript 写，只表达形状与语义；`bytes` 指二进制（不是 base64 字符串）。
时间一律 UTC ISO 字符串（[约定见 CLAUDE.md](../CLAUDE.md) 「Time is UTC everywhere except on screen」）。

### 4.1 身份与会话（9）

```ts
upsertUser(input: { issuer: string; subject: string; username: string | null;
                    email: string | null; name: string | null; avatarUrl: string | null;
                    roles: string[]; lastLoginAt: string }): Promise<User>
updateUser(userId: string, patch: Partial<Pick<User,'name'|'avatarUrl'|'username'|'email'>>): Promise<User>

createSession(input: { id: string; userId: string; accessToken: string;
                       refreshToken: string | null; idToken: string | null;
                       expiresAt: string; refreshExpiresAt: string | null;
                       sessionState: string | null; userAgent: string | null; ip: string | null }): Promise<void>
getSession(id: string): Promise<(Session & { user: User }) | null>
refreshSession(id: string, input: { accessToken; refreshToken; idToken;
                                    expiresAt; refreshExpiresAt; roles: string[] }): Promise<Session & { user: User }>
deleteSession(id: string): Promise<void>

createAuthRequest(input: { state; nonce; codeVerifier; redirectTo; expiresAt }): Promise<{ id: string }>
consumeAuthRequest(id: string): Promise<AuthRequest | null>   // 读到即删，原子
sweepExpired(before: string): Promise<{ sessions: number; authRequests: number }>
```

三个要点：

- `id` 由 Node 算（`HMAC-SHA256(SESSION_SECRET, cookie token)`）。后端看不到 cookie 里的原始 token，
  拖库也伪造不出 cookie —— 这个性质是现在就有的，下沉后更要保住。
- **`refreshSession` 必须原子**。它现在是 `prisma.$transaction([session.update, user.update])`：
  换完 token 的同时把 Keycloak 侧可能变过的角色同步进 `User.roles`。拆成两个调用，
  中间挂掉就会留下「新 token + 旧角色」。
- **`consumeAuthRequest` 必须原子**。现在是 `findUnique` + `delete` 两步，靠单进程凑合；
  跨网络之后这就是一个真实的重放窗口（同一个 `code` 被并发回调两次）。

### 4.2 项目 / 成员 / 邀请（12）

```ts
listProjectsForUser(userId, opts: { page; pageSize; keyword? })
  : Promise<{ items: ProjectSummary[]; total: number }>   // 只含 kind='team'、未软删
createProject(input: { name; description; userId }): Promise<ProjectSummary>
getProject(projectId, userId): Promise<ProjectSummary | null>
membershipOf(projectId, userId): Promise<{ role: 'admin'|'member'; kind: 'team'|'personal' } | null>
updateProject(projectId, patch: { name?; description? }): Promise<void>
softDeleteProject(projectId): Promise<void>

listMembers(projectId): Promise<ProjectMemberView[]>       // 带 user 的 name/username/email/avatarUrl
removeMember(projectId, userId): Promise<boolean>
countMembers(projectId): Promise<number>

ensurePersonalSpace(userId): Promise<ProjectSummary>       // 懒创建，并发安全
upsertInvite(input: { projectId; createdById; expiresInDays?;
                      mode: 'ensure'|'reset'|'expiry-only' }): Promise<ProjectInviteView>
previewInvite(token, userId): Promise<InvitePreview>
acceptInvite(token, userId): Promise<{ ok: true; projectId } | { ok: false; reason: InviteInvalidReason }>
```

- `ProjectSummary.memberCount` / `flowCount` **由后端算**，且 `flowCount` 要排掉软删画布
  （现在 Node 侧要额外做一次 `groupBy` 再拼回去 —— 那次往返没有理由留下）。
- `createProject` 里**创建者的 admin 成员行必须同事务写入**。这条是 [REQ-CANVAS §3.10](13-flow-canvas-management.md)
  的老规矩：admin 是写出来的，不从 `createdById` 推断。
- `ensurePersonalSpace` 的唯一性靠 `personalOwnerId` 的 unique 约束 + 撞键重查，
  **不靠先查后建**；这个竞态处理要跟着下沉，不能留在 Node（Node 那边重试会多两次 RTT）。
- 三个邀请方法（`ensureInvite` / `resetInvite` / `setInviteExpiry`）语义只差「换不换 token」
  和「过期了怎么办」，合成一个带 `mode` 的 upsert 更省往返；拆成三个也行，但语义不能改：
  **续期不换 token，重置立刻作废旧链接**。
- `acceptInvite` **幂等**：已是成员时直接返回成功，不写第二行。

### 4.3 画布元数据（7）

```ts
listFlowsByProject(projectId, opts: { page; pageSize; keyword?; status?; sort; order })
  : Promise<{ items: FlowSummary[]; total: number }>
countFlowsByProject(projectId): Promise<number>
createFlow(input: { projectId; name; description; createdById }): Promise<FlowDetail>
locateFlow(flowId): Promise<{ projectId: string; kind: 'team'|'personal' } | null>
getFlow(flowId, userId): Promise<FlowDetail | null>        // summary + graph + 该用户的 userState
updateFlow(flowId, patch: { name?; description?; status?; tags? }): Promise<FlowSummary>
softDeleteFlow(flowId): Promise<void>
duplicateFlow(flowId, createdById): Promise<FlowDetail | null>
```

- **每个返回画布的接口都要顺带带出所属项目的 `kind`**。`mode`（solo/collab）是从它派生的、
  不落库的（[REQ-SOLO §3.2](16-personal-flow.md)），Node 不能为了算 mode 再发一次请求。
- **软删过滤内建**：`flow.deletedAt IS NULL AND project.deletedAt IS NULL` 这个**联合**条件
  必须写在后端的查询里。让 Node 拿到行再判，等于把「已删画布不可读」这条规则复制了一份。
- `duplicateFlow` 在**后端内部**复制 `ydoc` 字节，不要拉到 Node 再传回去（最大 2MB，且没有意义）。
  调用顺序不变：路由仍要先 `flushRoomToDatabase(flowId)` 把内存里的房间落一次库，再调复制。

### 4.4 画布内容：两个方法，形状不能错

```ts
readFlowState(flowId): Promise<{ ydoc: bytes | null; graph: string; revision: number } | null>

writeFlowState(flowId, input: {
  ydoc: bytes
  /** 给了就是 CAS：只有库里 revision 等于它才写，否则 applied=false */
  expectedRevision?: number
  /** 不给就只写 ydoc + revision，不动派生投影 */
  projection?: { graph: string; nodeCount: number; edgeCount: number }
}): Promise<{ applied: boolean; revision: number }>
```

四条硬要求，少一条都会出事：

1. **`expectedRevision` 的 CAS 是必须的**。`flow-writer.ts` 的
   `updateMany({ where: { revision: 读到的值 } })` 是多副本下唯一防「后写整段覆盖先写」的东西
   （两个实例各自读-合并-写回）。协同落库那条走**无条件 `increment: 1`**，
   个人画布 REST 那条走 **CAS** —— 两种模式都要支持。注意它**不是**给客户端的乐观锁，
   撞车由 Node 自己重试（CRDT 重放幂等），客户端永远看不到 409。
2. **投影可选**。协同平时只写 `ydoc`；`graph` 要把整张图序列化成 JSON，和写 ydoc 同量级，
   每次都写等于开销翻倍。只在散场（`beforeUnloadDocument`）和个人画布推送时带上它。
3. **二进制不走 JSON**。ydoc 上限 20MB（`COLLAB_LIMITS.document`），单次消息上限 1MB
   （`COLLAB_LIMITS.message`）；base64 平白涨 1/3。用 `application/octet-stream` 或 gRPC `bytes`。
   注意投影那段 JSON 是另一个数（`GRAPH_LIMITS.bytes`，2MB），两者故意不相等。
4. **老数据迁移留在 Node**。`ydoc` 为 NULL 时从 `graph` JSON 现场构建一份 Y.Doc
   （`stateFromRow`，[REQ-COLLAB §3.5](04-realtime-collab.md)）——这需要 Yjs 运行时，
   所以后端只管把两个字段一起给出来，规则由 Node 保持唯一一份。

**合并（read → `Y.applyUpdate` → write）不下沉**，除非后端也跑 Yjs。后端在这里就是一个
带 CAS 的二进制 KV。

### 4.5 每人视图状态（2）

```ts
getFlowUserState(flowId, userId): Promise<Record<string, string>>          // key → JSON 字符串
patchFlowUserState(flowId, userId, patch: Record<string, string>): Promise<void>
```

`patch` 是 PATCH 语义（没带的 key 原样留着），按 `(flowId, userId, key)` upsert。
**一次调用写完整个 patch** —— 现在是 Node 侧循环 upsert，跨网络后必须合成批量。
这条同时是会话心跳，延迟敏感。

### 4.6 共享协调层：建议**不**下沉

现在有 7 张 `SharedMap` + 1 把 `SharedLock`：

| 键空间 | 用途 | 可丢? |
|---|---|---|
| `flow-state-vector` | 上次落库的状态向量，判「变没变」 | 可（最多多写一次库） |
| `awareness-claims` | clientID → 哪条 socket，防冒名 | 可 |
| `collab-holder` | 单连接互斥的持有者 + TTL | 可（降级为不互斥） |
| `collab-revocation` | 撤销广播 token，3s 轮询 | 不可（见 §6.2） |
| `quota-oversized` / `quota-locked` | 配额判定 | 可（本来就是最终一致） |
| `session-refresh-cooldown` | Keycloak 挂掉时的退避 | 可 |
| `session-refresh`（Lock） | refresh token 轮换的互斥 | **不可**（丢了会 `invalid_grant` 注销好会话） |

这些全是**毫秒级、高频、结构简单**的协调状态，走一趟业务后端的 HTTP 就废了
（`quotaLocked()` 甚至是**同步**调用的）。两个可行方案：① 保留 Redis 直连，Node 仍然自己连；
② 后端把 Redis 暴露给 Node。**不建议**把它们做成业务后端的接口。

## 5. 六条横切约束

1. **原子性**：`createProject`+admin 成员行、`refreshSession`+角色同步、`consumeAuthRequest`
   —— 三处必须在后端一次调用内完成。
2. **幂等与并发**：`ensurePersonalSpace`（unique 竞态）、`acceptInvite`（重复加入）、
   `writeFlowState`（CAS）。Node 侧会重试，后端不能因为重试产生第二行数据。
3. **软删语义内建**：所有读路径都带 `deletedAt IS NULL`，画布还要联合判所属项目。
4. **时间**：UTC ISO 字符串。注意画布**内容里**的时间是 epoch 毫秒数字
   （`FlowNodeData.createdAt`），那是 Y.Doc 里的东西，不经这些接口。
5. **服务间认证**：Node → 后端要有独立的服务身份（mTLS 或服务 token）。
   后端**不做**用户级鉴权判定（§3），所以它的接口一旦被直接访问就是全量越权 —— 网络层必须隔离。
6. **失败语义要能区分「拒绝」和「够不着」**。这是现有代码里反复出现的一条：
   `authorizeCollab` 抛异常 = 基础设施出问题 = **放行**，不踢人；`loadSession` 刷新失败时
   只有 Keycloak 明确 4xx 才注销，网络错误保留会话。后端的错误必须让 Node 分得清
   「你没权限」和「我没查到」—— 前者拒绝，后者放行并重试。混成一个 500，
   后端抖一下就会把所有人踢下画布。

## 6. 两件必须新增的东西

### 6.1 聚合鉴权接口（性能）

`authorizeCollab()` 现在是 3 次查询串起来的。下沉后它跑在每次握手、每 20s 的复验、
以及每个写帧上 —— 3 次 RTT × 那个频率不可接受。建议后端额外提供：

```ts
resolveFlowAccess(sessionId, flowId)
  : Promise<{ ok: true; user: SessionUser; projectId; kind; role }
          | { ok: false; reason: 'no-session' | 'no-flow' | 'not-member' }>

resolveProjectAccess(sessionId, projectId)
  : Promise<{ ok: true; user: SessionUser; kind; role } | { ok: false; reason: ... }>
```

一次 RTT 顶三次。返回的是**事实**（有没有会话、是什么角色、项目是什么形态），
把它翻译成 401 / 403 / 404 仍然是 Node 的事。

### 6.2 权限撤销的事件通道（正确性）

现在踢人是这样成立的：改权限的路由（移除成员 / 删项目 / 删画布）在写库成功后
`await revokeCollabAccess()` —— 本实例当场复验，跨实例靠一个共享 token + 3s 轮询。
**它成立的前提是「改权限的代码和协同服务在同一个进程里」。**

下沉之后这个前提没了：成员可能在后端侧、甚至在别的系统里被移除，Node 根本不知道。
后端必须提供其一：

- **webhook / 消息**：`POST {node}/internal/revocations`（Node 收到即跑一轮全量复验）；
- 或最省事的**版本号轮询**：`GET /revocations/token` 返回一个单调递增值，
  Node 每 3s 拉一次，变了就复验。这正是现在 `collab/revocation.ts` 的形状，
  只是把共享层换成后端的一个端点。

**不要跳过这一步**。少了它，被移出项目的人最长能继续写满一个 `REAUTH_INTERVAL`（20s），
他改的东西会被 CRDT 合并并落库，而**留下的人撤销不回来** ——
`Y.UndoManager` 的 `trackedOrigins` 只收自己的 `LOCAL_ORIGIN`，同步来的改动不进撤销栈；
一次 `deleteSelection()` 就能清空画布，而这个项目没有历史、没有回滚
（[README「已知问题」](README.md)：误删无法恢复）。

## 7. 建议的迁移顺序

一次全换风险太大，且中间态没法验。按「热度从低到高」切，每一步 Node 侧只改 `store/` 那一层的实现：

1. **项目 / 成员 / 邀请**（§4.2）—— 频率最低、语义最独立，用来验证服务间认证、错误映射、分页契约。
2. **画布元数据**（§4.3）—— 顺带把 `kind` 随行返回、`flowCount` 后端计算这两件事做掉。
3. **每人视图状态**（§4.5）—— 简单，但会第一次暴露延迟问题（它是心跳）。
4. **身份与会话**（§4.1）+ **聚合鉴权**（§6.1）—— 最热，必须在有缓存策略之后再切。
5. **画布内容**（§4.4）+ **撤销事件**（§6.2）—— 最危险，二进制 + CAS + 踢人，放最后。

共享协调层（§4.6）全程不动。

## 8. 验收标准

1. `server/` 下除了 `store/`（重命名为 client/adapter 亦可）与一处 HTTP 客户端，
   **没有任何文件 import `prisma`**；`server/db.ts` 与两个 driver adapter 从 `dependencies` 移除。
2. 现有测试全绿。`server/test/` 里用 `app.request()` 驱动的路由测试**一条都不用改**
   —— 这是「前端契约不变、鉴权判定留在 Node」是否真的做到了的判据。
   替换成一个假的后端客户端即可（比现在的 `prisma db push` 全量建库更快）。
3. 两个人同时编辑同一张协同画布，落库不丢改动（CAS + 无条件写两条路都走到）。
4. 一个人在两个实例上同时推送同一张个人画布，`applied=false` 会触发 Node 重试并最终收敛。
5. 移除成员后 **3 秒内**（跨实例）该用户的写帧被拒且连接被关闭 —— 撤销事件通道生效。
6. 后端整体不可达时：已建立的协同连接**不掉线**、不误踢人（§5.6 的失败语义），
   编辑落在本地 IndexedDB，恢复后补发。

## 9. 本期不做

- 把 Yjs 合并下沉到后端（需要后端跑 CRDT 运行时，收益只是省一次读）。
- 把鉴权判定（404/403 规则）下沉。
- 共享协调层下沉（§4.6）。
- 读缓存层。真要做，先做 `resolveFlowAccess` 的短 TTL 缓存 —— 写入闸门已经有一套
  「缓存判定 + 事件驱动失效」的现成模式可抄（`collab/write-gate.ts`）。
- 画布内容的增量存储（基线 + 增量链）。和下沉无关，见 [README 优化项 3](README.md)。

## 10. 待确认事项

1. **协议**：REST + protobuf/octet-stream，还是 gRPC？画布内容那两个方法的二进制形状是决定性因素。
2. **会话是否整体下沉**：本文假设 HMAC 与 token 刷新留在 Node（BFF 的性质就在这里），
   后端只做会话行的 CRUD。若后端想接管刷新，Keycloak 凭证就得给它，
   并且 `session-refresh` 那把锁也要跟着换地方。
3. **`sweepExpired` 归谁**：Node 定时调，还是后端自己跑定时任务？后者更合理，
   但要确认「会话过期」的口径（`authConfig.ttl`）由谁定义。
4. **后端是否已有等价的用户体系**。若有，`upsertUser` 可能变成「按 (issuer, subject) 查已有用户」，
   `User` 表整张不迁 —— 那会连带影响 `avatarUrl` 补齐（`auth/profile.ts` 的 hook）往哪写。
5. **多副本下 Node 还需不需要 Redis**。按 §4.6 是需要的；如果部署上不想要两个中间件，
   就得接受单连接互斥、awareness 防冒名这些功能在多副本下降级。
