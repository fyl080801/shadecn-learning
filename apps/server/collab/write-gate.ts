import { authorizeCollab, type CollabDenialReason } from '../auth/ws.ts'

/**
 * 写操作的认证闸门 —— 「登录态没了 / 已经不是成员了」之后的编辑，**在进 Y.Doc 之前**拦住。
 *
 * ## 为什么单独有这么一道
 *
 * `onConnect` 只在握手时跑一次，之后靠 `revalidateConnections` 每 `REAUTH_INTERVAL`
 * 复验一轮、把不合格的连接踢下线。但「踢下线」是**连接级**的动作，它和「这一帧要不要
 * 应用」之间隔着一段时间：复验的间隔、跨实例广播的巡检周期，以及 `closeForGood` 之后
 * 消息队列里还排着的帧（Hocuspocus 的 `Connection` 没有 closed 标志位，
 * `processMessages` 也不检查连接是否还挂在文档上）。那段时间里到达的更新会被
 * 正常应用、广播、落库，而且**别人撤销不回来** —— `Y.UndoManager` 的 `trackedOrigins`
 * 只收自己的 `LOCAL_ORIGIN`，同步过来的改动一律不进撤销栈。
 *
 * 所以拦截必须落在消息级，落在 `readUpdate` 之前。
 *
 * ## 为什么挂在 `beforeSync` 而不是 `beforeHandleMessage`
 *
 * `beforeHandleMessage` 对**每一帧**都跑，包括 awareness —— 拖拽时光标每次 pointermove
 * 一帧，一秒几十次。而 `beforeSync` 只在 sync 消息内、读出消息类型之后触发
 * （`MessageReceiver.readSyncMessage`），于是两件事一起成立：
 *
 * - **只有写帧付出认证成本**：`type` 分得清 SyncStep1（读）和 SyncStep2 / Update（写）。
 *   纯浏览的人一次查询都不产生；拖拽中间态本来就不进 Y.Doc（只有 `onNodeDragStop`
 *   提交那一下），所以写帧的密度跟真实编辑次数走，不跟手的动作走。
 * - **它跑在 `readOnly` 检查之前**，所以在这里把连接置成只读，当前这一帧就会被
 *   Hocuspocus 自己 NACK 掉。
 *
 * ## 为什么拒绝走 `readOnly` 而不是 `throw`
 *
 * 和配额那道是同一条理由（见 `hocuspocus.ts` 的 `beforeHandleMessage`）：抛出去的话
 * `processMessages` 会接住并关连接，而 provider 自动重连、重发同一条消息 —— 死循环。
 * 置只读则是 Hocuspocus 支持的拒绝方式：SyncStep2 / Update 回一个
 * `syncStatus=false` 的 NACK，**不应用、不广播、不进 `onChange`、不进落库队列，也不断连**。
 *
 * ## 判定要缓存，但**不能**攒批延迟
 *
 * 「攒一批写帧再一起认证」是走不通的：Hocuspocus 的消息处理是单队列串行
 * （`Connection.processMessages`），在这个 hook 里 await 一个定时器会把这条连接的
 * 所有后续帧堵在队列后面，包括 awareness 心跳 —— 心跳一堵，服务端 30 秒超时判死。
 * 而且协同的实时性也就没了。
 *
 * 正确的降频是**缓存判定结果**：每帧都过闸门，但命中缓存时只是一次 `Map.get`，
 * 帧不被延迟。查询频率因此是「每个正在编辑的连接每 {@link WRITE_VERDICT_TTL} 一次」。
 *
 * ## TTL 可以放得比较长，因为紧急的那半是事件驱动的
 *
 * 两件事的时效性完全不同：
 *
 * - **权限被收回**（移出项目、删项目、删画布）根本不需要靠时间发现 ——
 *   改权限的路由会 `await revokeCollabAccess()`，那条路汇进 `revalidateConnections`，
 *   而它开头就把这张表清空。于是下一个写帧必然重查，窗口 ≈ 0，不花任何轮询成本。
 * - **登录态过期**只能靠 TTL 兜底，而它的发现下限本来就受制于 access token 的寿命
 *   （`loadSession` 在 access token 进入 30 秒刷新窗口之前根本不问 Keycloak），
 *   TTL 取 2 秒还是 10 秒对这条几乎没有区别。
 *
 * 所以取长 TTL + 事件驱动失效：比原来 20 秒的复验查得更少，窗口反而更短。
 */

/**
 * y-protocols/sync 的消息类型。
 *
 * **故意写成字面量而不是 `import { messageYjsUpdate } from 'y-protocols/sync'`**：
 * `y-protocols` 是 devDependency（前端才直接用它，服务端只是间接依赖
 * `@hocuspocus/server`），而 `scripts/build-server.mjs` 会在打包时检查
 * 「bundle 引用的包是不是都在 `dependencies` 里」，引它就会让构建失败。
 * 这三个数是线协议的一部分，改了就不兼容，不会变。
 */
const SYNC_STEP_1 = 0
const SYNC_STEP_2 = 1
const SYNC_UPDATE = 2

/** 这条 sync 消息是要**写**吗（SyncStep1 是客户端来问「你有什么我没有的」，是读） */
export function isWriteSync(type: number): boolean {
  return type === SYNC_STEP_2 || type === SYNC_UPDATE
}

/** 只在测试里用得上，导出是为了别让这三个数在断言里再抄一遍 */
export const SYNC_MESSAGE_TYPES = {
  step1: SYNC_STEP_1,
  step2: SYNC_STEP_2,
  update: SYNC_UPDATE,
} as const

/**
 * 判定的有效期。见上面「TTL 可以放得比较长」—— 它只兜底登录态那半，
 * 权限撤销由 `revalidateConnections` 清表，不受这个数影响。
 */
export const WRITE_VERDICT_TTL = 10_000

/** `null` = 放行 */
export type WriteVerdict = CollabDenialReason | null

/**
 * 闸门要的那点鉴权能力 —— **这是通道之间唯一的差异点，所以它是注入的**。
 *
 * 闸门本身（缓存、TTL、事件失效、「拒绝长什么样」）对两种画布是同一套，
 * 但「查什么」不是：
 *
 * - **项目画布**：登录态 + 房间归属 + 项目成员身份（{@link collabWriteAuthorize}）。
 *   它走 WebSocket，一条连接握手一次、之后长期复用，所以才需要这道闸门。
 * - **个人画布**：只有登录态（{@link sessionWriteAuthorize}）—— 它没有成员这回事，
 *   归属就是「是不是我的」。
 *
 * 把它做成参数而不是在实现里 `if (personal)` 分叉，是因为那个 `if` 会让闸门知道
 * 「什么是项目」。通道的形状本来就该由**调用方**声明：谁挂这道闸门，谁说清楚它查什么。
 *
 * 收窄成这个形状还顺带让测试能喂一个假的，不用碰数据库。
 */
export type AuthorizeWrite = (
  cookie: string | null,
  room: string,
) => Promise<WriteVerdict>

export interface WriteGateOptions {
  /**
   * 查什么 —— **必填，没有默认值**。
   *
   * 不给默认是刻意的：默认成「项目画布那一套」的话，将来给别的通道挂闸门时
   * 少写一个参数就会静默地多查一次项目成员身份（对个人画布永远是 `forbidden`）。
   * 让它必填，选择就摆在调用点上。
   */
  authorize: AuthorizeWrite
  ttlMs?: number
  /** 注入时钟；测 TTL 用 */
  now?: () => number
}

export interface WriteGate {
  /**
   * 这条连接现在还能写吗。`null` = 能。
   *
   * 缓存的是 **Promise 而不是结果**，所以它同时也是一次 in-flight 去重：
   * 同一条连接的消息本来就是串行处理的，但握手预填和第一个写帧撞在一起时
   * 不必查两遍。
   */
  check(socketId: string, room: string, cookie: string | null): Promise<WriteVerdict>
  /** 握手刚认证过，把结论直接填进去，省掉编辑开始时的第一次查询 */
  prime(socketId: string): void
  /** 连接断了 */
  forget(socketId: string): void
  /** 全表作废 —— 复验（含主动撤销那条路）跑之前调它 */
  clear(): void
  /** 现在缓存着几条；只给测试和排查用 */
  size(): number
}

interface Entry {
  at: number
  verdict: Promise<WriteVerdict>
}

/**
 * 造一个闸门。
 *
 * 生产环境只有一个（`hocuspocus.ts` 的模块级），做成工厂是为了测试能造出
 * 互不干扰的多个、并注入假的鉴权和时钟 —— 和 `createRevocationWatcher()` 同一个理由。
 */
export function createWriteGate(options: WriteGateOptions): WriteGate {
  const { authorize, ttlMs = WRITE_VERDICT_TTL, now = Date.now } = options

  /*
   * key 是**没加实例前缀的** `socketId`。这张表纯粹是进程内缓存，不进共享层，
   * 而 socketId 在一个进程内已经唯一（Hocuspocus 发的 uuid）——
   * `scopedSocketId` 是给会跨实例比对的东西用的（awareness 归属、单连接持有者），
   * 这里加前缀只是徒增噪音。
   */
  const entries = new Map<string, Entry>()

  function check(socketId: string, room: string, cookie: string | null) {
    const cached = entries.get(socketId)
    if (cached && now() - cached.at < ttlMs) return cached.verdict

    const verdict = authorize(cookie, room).catch((err: unknown) => {
      /*
       * 抛异常 = 数据库 / Keycloak 出了问题，**证明不了任何事**：放行，下一帧再查。
       * 和 `revalidateDocument`、`session.ts` 对刷新失败的态度是同一条 ——
       * 没有证据不拒人。基础设施抖一下就让所有人写不了画布，比多放行一帧糟得多。
       */
      console.warn(`[collab] ${room} 的写入鉴权失败，本帧放行`, err)
      return null
    })

    entries.set(socketId, { at: now(), verdict })
    return verdict
  }

  return {
    check,
    prime(socketId) {
      entries.set(socketId, { at: now(), verdict: Promise.resolve(null) })
    },
    forget(socketId) {
      entries.delete(socketId)
    },
    clear() {
      entries.clear()
    },
    size: () => entries.size,
  }
}

/**
 * **项目画布**的检查：一次 `authorizeCollab` 把登录态、房间归属和项目成员身份一起查了。
 * 这是 `hocuspocus.ts` 注入的那个。
 *
 * **`refresh: false`** —— 和定期复验同一条规矩：这背后没有真实的用户 HTTP 请求，
 * 让它续期就等于「一直编辑就永不登出」，长连接自己给自己续命。续期归真实请求管
 * （编辑触发的那次视图状态 PATCH 就是干这个的）。
 */
export const collabWriteAuthorize: AuthorizeWrite = async (cookie, room) => {
  const result = await authorizeCollab(cookie, room, { refresh: false })
  return result.ok ? null : result.reason
}

/**
 * **只查登录态**的检查 —— 通用的那一半，个人画布要的就是这个。
 *
 * 它现在没有调用方，这是有意留的形状而不是死代码：个人画布的写入走 REST
 * （`POST /api/flows/:id/doc`），而那条路上的**每一个请求**都完整过一遍
 * `withSession` → `requireAuth` → `requireFlowMember`（`routes/flows.ts`），
 * 逐请求鉴权，根本没有「握手过一次就长期复用」的窗口，也就不需要闸门。
 *
 * 换句话说：个人画布的闸门就是 HTTP 中间件链本身。等哪天它换成长连接
 * （或者要给它加同样的判定缓存），注入这个就行，闸门的其余部分一行都不用改。
 * 房间名在这里用不上 —— 「是不是我的画布」由调用方那层管，这里只回答「人还在不在」。
 */
export const sessionWriteAuthorize: AuthorizeWrite = async (cookie) => {
  // 空房间名：`authorizeCollab` 只有在房间名以 `flow:` 开头时才去查画布和成员，
  // 传空串就正好停在「会话有效吗」这一步
  const result = await authorizeCollab(cookie, '', { refresh: false })
  return result.ok ? null : result.reason
}
