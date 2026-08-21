# REQ-CLUSTER 单副本 / 多副本双模式

> 状态：**已实现** —— 抽象层、Redis 实现、协同层接入、契约测试、本地多实例启动方式都已落地。
>
> 前置：[REQ-COLLAB](04-realtime-collab.md)（房间与 Y.Doc）、[REQ-DATA](05-data-persistence.md)（两种库一套模型）、
> [REQ-DEPLOY](12-deployment.md)（构建产物与 k8s）。

## 1. 目标

1. **单副本是默认形态，行为一字不改**：什么都不配就跑成一个进程，共享状态全在内存里，
   一行 Redis 代码都不加载，也不多一个外部依赖。
2. **多副本靠配置打开**，不是靠另一套代码、另一个构建产物：同一个镜像，改环境变量就换模式。
3. **数据库和 Redis 分开配**：`DB_PROVIDER` / `DATABASE_URL` 管库，`CLUSTER_MODE` / `REDIS_URL` 管副本，
   谁也不推断谁。
4. 进程内那些 `Map` 收敛成**抽象类**，两套实现（内存 / Redis）跑同一组契约测试。

## 2. 背景：为什么以前只能 `replicas: 1`

两条互相独立的原因，任一条都足够：

- **Y.Doc 只活在一个进程的内存里。** 两个 Pod 各持一份互不通信的副本，各自把**自己**那份
  全量写进同一行 `ydoc` —— 而落库是覆盖写不是合并，后写的把先写的整段盖掉。这是真丢数据，
  不是「看不见对方的光标」而已。
- **SQLite 是单文件**，挂在 `ReadWriteOnce` 的卷上，两个 Pod 连挂载都挂不上。

除此之外还有一串靠「只有一个进程」这个前提成立的模块级 `Map`：

| 位置 | 状态 | 多副本下会怎样 |
|---|---|---|
| `collab/persistence.ts` | 上次落库的状态向量 | 各自误判「和上次一样」而跳过写，跳掉的是对方的版本 |
| `collab/quota.ts` | 软限 / 硬限标记 | 每个进程只量到自己那半流量，配额形同虚设 |
| `collab/awareness.ts` | clientID 归属登记 | 冒名者连到另一个实例就绕过了防线 |
| `auth/session.ts` | 刷新互斥、失败冷却 | 两个实例拿同一个 refresh token 去换，轮换开着时后到的被判 `invalid_grant`，会话被注销 |

## 3. 功能需求

### 3.1 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `CLUSTER_MODE` | 按 `REDIS_URL` 推断 | `single` / `redis`。显式设了以它为准 |
| `REDIS_URL` | 无 | `redis://[:password@]host:port[/db]`，密码走连接串 |
| `REDIS_KEY_PREFIX` | `shadecn` | 多环境共用一台 Redis 时隔离键空间 |
| `INSTANCE_ID` | `${hostname}-${8位随机}` | 实例身份，k8s 里注入 `metadata.name` |
| `DEV_CLUSTER_PORTS` | `3000,3001` | 只有 `pnpm dev:cluster` 读它 |

解析规则和 `DB_PROVIDER` **逐条一致**：显式变量最优先 → 看连接串在不在 → 默认最省事的那个。

启动时的两条校验（`assertClusterConfig()`），性质不一样：

- 说要 `redis` 却没有 `REDIS_URL` —— **配置自相矛盾**，任何环境都拒绝启动；
- `redis` 配着 SQLite —— 真多副本时不成立，但**本地拿 SQLite + Redis 单进程验证 Redis 那条链路
  是合理的调试姿势**，所以开发环境只警告，生产才拒绝。

### 3.2 抽象层（`server/cluster/`）

按**用途**分三个抽象类，不是按数据结构分：

| 抽象 | 回答的问题 | 单副本 | 多副本 |
|---|---|---|---|
| `SharedMap<V>` | 这个键是什么值 / 我能不能占住它 | `Map` + 惰性过期 | `GET` / `SET [PX]` / `SET NX` |
| `SharedCounter` | 下一个号是几 | 计数器 | `INCR`，键不存在时按库里的最大值播种 |
| `SharedLock` | 同一时刻只许一个人做这件事 | 进程内 promise 去重 | `SET NX PX` + 带 token 的 Lua 释放 |

三条约束写死在设计里：

- **所有方法都是异步的**，哪怕内存实现根本不需要 —— 否则接 Redis 那天每个调用点都要改签名。
- **工厂返回的是懒代理**：模块在顶层声明自己要用的表（就像以前 `new Map()`），
  而挑实现要等 `initCluster()`（`await import('ioredis')`，异步）。代理在第一次被调用时
  才从当前 backend 取实现，换 backend 只需把代数 +1。
- **Redis 实现是动态 import 的**：单副本进程里 ioredis 连加载都不会发生。

`SharedLock` 的两种实现语义**故意不同**，但共同满足「任务只跑一次」：进程内实现复用同一个
in-flight promise；Redis 实现跨进程共享不了 promise，所以后来者等锁释放然后跑 `fallback`
（通常是重读一遍库）。因此 `fallback` 必须能独立得出正确答案。

### 3.3 协同层

多副本下挂上官方的 [`@hocuspocus/extension-redis`](https://tiptap.dev/docs/hocuspocus/server/extensions/redis)，它一次解决三件事：

- 文档更新和 awareness 经 Redis pub/sub 在实例间转发；
- `onStoreDocument` 用 redlock 去重，同一房间同一时刻只有一个实例真的落库 —— 上面那个覆盖写丢数据的洞就是它堵的；
- `afterLoadDocument` 会等别的实例把内存里的当前状态推过来（`awaitInitialSyncTimeout`，默认 1s），
  否则刚接手的实例会拿库里那份旧的去服务客户端。

**socketId 要加实例前缀**（`instanceId:socketId`）：Hocuspocus 的 socketId 只在单进程里唯一，
而 awareness 的归属登记正是靠它判断「这个 clientID 是不是你的」，撞号会让正主的更新被当成冒用丢掉。

**每条更新的副作用只该由收到客户端消息的那个实例执行。** 同一条更新会经 pub/sub 转发到每个
持有该房间的实例，每个都触发一次 `onChange` —— 照单全收的话副作用就成了实例数的倍数
（当年还有审计表时实测过：两个实例、11 次改动写出 22 行），而且转发来的那条手里没有作者的
`context`。判据是 `transactionOrigin.source !== 'redis'`；认不出形状时按「执行」处理。
目前 `onChange` 里只剩配额计量（本来就是按实例各算各的），但将来接 webhook、通知、埋点时要记得这一条。

**不需要 sticky session**：任意实例都能服务任意房间，这正是 extension 的作用。
同一个房间的协作者本来就来自不同浏览器，粘也粘不到一起。

### 3.4 哪些**不用**改

- `revalidateConnections`：每个实例只遍历自己的连接，天然可扩展。
- `persistence.ts` 的写队列：只需本实例内保持顺序，跨实例那道是 `flow-writer.ts` 里对 `revision` 的 CAS。
- 前端：客户端不知道自己连的是哪个实例，`useFlowCollab` 一行没动。

## 4. 取舍

- **配额是弱一致的**。`quotaLocked()` 在 `beforeHandleMessage` 里被**同步**调用，每条消息一次，
  那条路上加一次 Redis 往返不能接受。所以是「本地判定 + 共享传播」：判定结果顺手写进共享层（不等结果），
  复量那一拍（1～5 秒）顺手把别的实例的判定拉回来。代价是标记有几秒延迟，超限房间可能在别的实例上
  多接受一小段写入 —— 这和配额本身「事后记账、下一条消息才生效」的语义是一致的。
- **awareness 归属只在首次走网络**。一个 clientID 第一次出现时 `claim()`，之后全在本地缓存里判 ——
  归属一旦定下就不会变（要变只能先断连释放，那时缓存一并清掉）。
- **Redis 只是缓存，不放业务数据**。里面全是可重建的东西：状态向量丢了最多多写一次库，
  归属登记丢了靠 TTL 自愈，配额标记丢了下次 `checkQuota` 重新判。所以不需要持久化配置，
  重启 Redis 不丢任何用户数据。
- **`GET /api/collab/rooms` 变成「每个 Pod 各报各的」**。要全局视图得再做一层聚合，本期不做。

## 5. 本地怎么跑

依赖服务自己起（脚本不代劳，命令在 `.env.example` 里）：

```bash
podman run -d --name shadecn-redis -p 127.0.0.1:6379:6379 redis:7-alpine
podman run -d --name shadecn-postgres -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=app postgres:17-alpine
```

然后配 `.env`（`REDIS_URL`，真多副本再加 PostgreSQL 的 `DB_PROVIDER` / `DATABASE_URL`，
换库记得 `pnpm db:generate && pnpm db:push`），跑：

```bash
pnpm dev          # 单副本，现状
pnpm dev:cluster  # 按 DEV_CLUSTER_PORTS 拉起多个实例
```

`scripts/dev-cluster.mjs` **不含任何配置**：只覆盖每实例必须不同的 `PORT` 和 `INSTANCE_ID`，
其余全从 `.env` 读。本地多副本时把 `APP_ORIGIN` 注释掉，让它按各自端口推导，
否则 3001 上登录会跳回 3000（用 Keycloak 的话两个端口的回调都要注册，或者干脆不配 Keycloak 裸跑）。

## 6. 验收标准

- [x] 不配任何 Redis 相关变量时行为与改造前完全一致，测试全绿。
- [x] 抽象层的契约测试：同一组用例，内存实现必跑，设了 `TEST_REDIS_URL` 时 Redis 实现再跑一遍。
- [x] `CLUSTER_MODE=redis` 缺 `REDIS_URL` → 启动失败；配 SQLite → dev 警告、prod 失败。
- [x] 两个实例（3101 / 3102）连同一个房间：内容双向同步、并发改动收敛、awareness 互相可见。
- [x] awareness 的归属登记确实进了 Redis（`shadecn:awareness-claims:<room>:<clientID>`），断连即释放。
- [x] 生产镜像同时支持两种模式，模式只由环境变量决定（唯一绑构建的仍是数据库 provider）。

**PostgreSQL 上的完整实测**（`DB_PROVIDER=postgresql` + Redis + 两个实例）：

- [x] PG 库从零 `db push` 建表通过，表结构正确（`Flow.ydoc` 是 `bytea`）。
      （当时走的还是迁移文件，后来项目改成了 db push —— 见 [REQ-DATA §3.3.1](05-data-persistence.md)；
      这一项按新方式重跑过。）
- [x] 一个实例建项目、另一个实例在同项目下建画布，读写同一个库。
- [x] 真实画布房间 `flow:<id>`：两端交替写 10 个节点 + 一条跨端连线，两个实例都收敛到 10/1。
- [x] 落库正确：`revision` 前进，两个实例读到同一份数据；散场后派生投影补上（`nodeCount=10` / `edgeCount=1`）。
- [x] **实例故障**：一个实例被 SIGTERM 掉（且不等它的落库防抖窗口），另一个实例上的协作者内容完好、
      能继续编辑，新连上来的人看到全部内容，散场后库里的节点数正确。这就是滚动更新的场景。

## 7. 本期不做

- **`GET /api/collab/rooms` 的跨实例聚合** —— 现在每个 Pod 只报自己的房间。
- **Redis 高可用**（Sentinel / Cluster）—— ioredis 支持，但没配也没测。
- **优雅缩容**：Pod 被 kill 时它持有的房间连接会断，客户端由 provider 自动重连到别的实例，
  中间有一下抖动。没做主动的连接迁移。
- **限流 / 熔断**：Redis 挂掉时，共享状态的读写会失败，代码里一律按「保守放行」处理
  （配额不拦、归属不判），没有做降级告警。

## 8. 待确认

- `awaitInitialSyncTimeout` 用的是默认 1s。跨机房部署时可能要调大，本地和同机房无所谓。
