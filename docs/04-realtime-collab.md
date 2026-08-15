# REQ-COLLAB Yjs 实时协同

> 状态：**部分实现** —— 服务端完整可用，前端尚未接入任何页面，文档也没有持久化。

## 1. 目标

在既有的单进程服务端上提供一个 Yjs 同步端点，验证：

- CRDT 协同能不能复用应用自己的登录态（而不是另起一套 token）；
- 不依赖官方 `@y/websocket-server` 包也能提供标准兼容的服务端。

## 2. 背景：为什么自己实现服务端

`server/collab/setupWSConnection.ts` 是 y-websocket `bin/utils.js` 的移植，**刻意不用**上游 `@y/websocket-server`：

- 该包静态 import `y-leveldb` → `leveldown`，这是个原生模块，在 node 22 / arm64 上没有预编译产物，import 直接抛错；
- 去掉该依赖的 0.1.5 版本要求 yjs 14 beta，而稳定版 `y-websocket@3` 客户端无法与之通信。

移植版**未改动线协议**，标准 y-websocket 客户端可直接连接。

## 3. 功能需求

### 3.1 端点

- 地址：`ws://<host>:<port>/ws/<room>`，与 HTTP 服务同端口同源。
- 一个 room = 一个内存中的 `Y.Doc`；房间名从 URL 路径取。
- 只接受 `/ws/*` 的 upgrade 请求。

### 3.2 握手鉴权

- 握手是普通 HTTP 请求，同源会自动带上 `sid` Cookie。
- 用与 HTTP 相同的会话校验逻辑（`server/auth/ws.ts`）；未登录返回 `401` 并销毁 socket。

### 3.3 与 Vite HMR 共存

- 开发环境下 Vite 的 HMR socket 也走同一个 `upgrade` 事件（协议 `vite-hmr`，路径 `/`）。
- 因此开发环境 `destroyUnmatchedUpgrades` 必须为 `false`，否则会把 HMR 连接杀掉。
- 生产环境为 `true`：不匹配 `/ws/*` 的 upgrade 一律销毁。

### 3.4 运行参数

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `YWS_PING_TIMEOUT` | 30s | 心跳超时，超时断开 |
| `YWS_GC` | 开启 | 设为 `false` / `0` 关闭 Yjs GC —— **使用快照功能时必须关闭** |
| `YWS_STATS_INTERVAL` | 30s | 统计日志间隔，`0` 关闭 |

### 3.5 监控端点

`GET /api/collab/rooms` 返回：

```jsonc
{
  "rooms": [{ "name": "…", "connections": 2, "awarenessClients": 2 }],
  "totalRooms": 1,
  "totalConnections": 2
}
```

### 3.6 前端接入约定

- 使用 `y-websocket` 的 `WebsocketProvider`，第一个参数传由当前 `location` 推导出的**绝对 ws:// / wss:// 地址**（路径 `/ws`），不要硬编码 host。
- 文档只在内存中，**服务端重启会丢失全部内容** —— 接入方必须接受这个前提，或先补齐持久化。

## 4. 已知缺口

- 前端没有任何页面接入协同，只有服务端在跑。
- 没有持久化（无 LevelDB / 无数据库落盘），重启即丢。
- 没有房间级授权 —— 任何已登录用户可以进任何房间。
- awareness 里的用户身份没有与服务端会话绑定，客户端可以自称任意身份。

## 5. 验收标准

- [ ] 两个浏览器标签连同一个 room，一边的修改能实时同步到另一边。
- [ ] 未登录直接连 `/ws/test` 收到 401 并断开。
- [ ] 开发环境下协同连接和 Vite HMR 同时工作，互不影响。
- [ ] 断网 / 挂起超过心跳超时后连接被回收，`/api/collab/rooms` 中的计数随之下降。
- [ ] 客户端断线重连后能恢复到最新文档状态（前提是服务端未重启）。

## 6. 本期不做

- 文档持久化与历史版本 / 快照。
- 房间级权限（谁能进哪个房间、只读 / 可写）。
- 多实例间的房间同步（跨进程广播）。
- 离线编辑与冲突提示 UI。

## 7. 待确认事项

- 沙盒里哪个页面来做协同的首个落地场景（流程图画布和富文本编辑器都是候选）。
- 持久化选型：直接写 SQLite，还是等 y-websocket 生态里出现无原生依赖的方案。
