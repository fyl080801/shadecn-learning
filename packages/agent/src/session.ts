import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { validateToolArguments, type Api, type Model, type ToolCall, type ToolResultMessage } from '@mariozechner/pi-ai'
import {
  AGENT_PROMPT_MAX_LENGTH,
  AGENT_SUMMARY_MAX_LENGTH,
  AGENT_TITLE_MAX_LENGTH,
  AgentEventType,
  canonicalSkillIds,
  NODE_MENTION_PATTERN,
  parseNodeMentions,
  withMine,
  type AgentCanvasChangeMessage,
  type AgentChatMessage,
  type AgentSkillLoadedMessage,
  type AgentSkillView,
  type AgentConversationSummary,
  type AgentConversationView,
  type AgentRunEntry,
  type AgentSessionView,
  type AgentStreamEvent,
  type AgentUserView,
} from '@shadecn/shared/agent'
import { createId } from '@shadecn/shared/id'
import {
  RunAuthorityError,
  stopsRun,
  type AgentCapability,
  type RunAuthority,
  type RunAuthorityProvider,
} from './authority.ts'
import type { CanvasActor, CanvasHandle } from './canvas.ts'
import {
  canvasChangeMessage,
  closingDigest,
  createCanvasWatch,
  diffDigests,
  mergeNotices,
  renderNotice,
  type CanvasChangeNotice,
  type CanvasDigest,
  type CanvasWatch,
  type NoticeLimits,
} from './canvas-changes.ts'
import { createRunEventMapper, type RunOutcome } from './events.ts'
import { createAgentGateway, isProxiedModelApi, PROXIED_MODEL_APIS, type GatewayRun } from './gateway.ts'
import type { MediaReader } from './media.ts'
import type { ResolvedAgentModel } from './model.ts'
import { expandMentions, loadedSkillText, lookupMention, systemPromptFor } from './prompt.ts'
import type {
  CanvasChangesResponse,
  FinishRequest,
  RunnerEvent,
  RunnerInput,
  RunnerModel,
  ToolCallRequest,
  ToolCallResponse,
} from './protocol.ts'
import type { SandboxDriver, SandboxExit, SandboxHandle, SandboxResources } from './sandbox/driver.ts'
import {
  BUILTIN_SKILLS,
  createLoadSkillTool,
  LOAD_SKILL_TOOL_NAME,
  NO_SANDBOX,
  type AgentSkill,
  type SkillAvailability,
  type SkillContext,
  type SkillRegistry,
} from './skills/index.ts'
import type {
  AgentConversationStore,
  AgentRunFinish,
  AgentRunLog,
  AgentRunStart,
  StoredConversation,
  StoredConversationMeta,
} from './store.ts'
import { readNodeById, type CanvasTool, type ToolRunState } from './tools.ts'

/**
 * 编排：会话、「一个会话同时只跑一轮」、把一轮 pi Agent 跑完。
 *
 * ## 什么持久化、什么在内存
 *
 * - **会话**（对话记录 + 模型上下文）经注入的 {@link AgentConversationStore} 落库，按「画布 + 发起人」归属，
 *   一个人在一张画布上可以有多个会话；项目画布上别人的会话只读可见（读的口径见 store.ts「归属」）。
 *   进程重启、换到另一个副本，会话都还在。
 * - **运行日志**（每轮一行 + 每次工具调用一行）经注入的 {@link AgentRunLog} 落库，审计用途。
 * - **「谁在跑」**（`runs` + `busyConversations`）是进程内存里的 `Map`：**多副本之间不共享** ——
 *   「一个会话同一时刻一轮」只在单副本下成立，任务列表也只列本进程的；进程重启时正在跑的轮次随之没了。
 *   跨副本的 run 注册表要上共享层（`SharedMap.claim` + TTL + 心跳，docs/20 §3.7.2），属于 F14，留到后续。
 *
 * ## 并发单位是会话
 *
 * 一个会话同时只跑一轮；不同会话、不同的人在同一张画布上可以同时跑（docs/20 §3.10.3），
 * 并发写靠 `flow-ops` 每次调用一个原子事务守住不变式。**每一轮自己的状态都挂在它自己的 `RunState` /
 * `execute` 闭包上**：删除预算与图片字节预算（每轮新建一份 `runState`，这一轮所有技能的工具共用）、工具调用计数与日志、
 * 已加载的技能与加载次数、补发缓冲、订阅者、中止开关、时长计时器 —— 没有任何按画布共享的计数。每用户 / 每画布的并发上限只做规划（§3.10.6）。
 *
 * ## 运行中任务列表
 *
 * 一轮在 RUN_STARTED 发出（会话已建好、标题与发起人已知）之后才进列表（{@link AgentRuntime.activeRuns}），
 * 彻底结束（从 `runs` 删掉）时离开；两个时刻各调一次 `onRunsChange`，宿主拿去广播给房间。
 * 准备会话就失败的那种（只发一帧 RUN_ERROR）从没进过列表，也就不会「出现又消失」。
 *
 * ## 一轮的生命周期与失败语义
 *
 * `start()` **同步**占住这个会话的槽位（同一会话的第二个发起者立刻得到 `busy`，中间没有 await 可插队；
 * 新会话没有可撞的槽位，总能开始），然后异步跑：
 *
 * 1. **准备会话**：没给会话 id 就 `create`（标题取自这条用户消息），给了就读出来（含模型上下文），
 *    把用户消息追加进去并 `save`。这一步**先于调用模型**：用户消息先落库，模型再贵也不会白跑一趟却没留下记录。
 *    失败（库挂了 / 会话在这之间被删了）→ 只发一帧 RUN_ERROR，模型不调、画布不开。此时还没有 RUN_STARTED ——
 *    新会话根本没建起来，拿不出 threadId。
 * 2. 发 RUN_STARTED（threadId = 会话 id）+ 回显用户消息，写运行日志的开头一行。
 * 3. 签 Grant → 打开画布 → 展开提及 → 在网关登记这一轮、让驱动起一个沙箱跑 runner（pi 在那里），
 *    等沙箱退出。runner 上报的事件经 `events.ts` 映射后发出去；每次工具结束写一行工具调用日志。
 * 4. **一次** `save` 把 assistant 消息、模型上下文、summary、messageCount、updatedAt 落库 ——
 *    success / cancelled / error 都要走到这一步。save 失败：console.error，并且**这一轮以 RUN_ERROR 收尾**，
 *    说明「对话没能保存」：画布上的改动已经在了，可这一轮的对话刷新就会丢，用户必须知道。
 * 5. 发最后一帧，关画布，写运行日志的结尾一行。
 *
 * ## 大脑在沙箱里（docs/22 §4，二期）
 *
 * pi 的推理循环跑在沙箱里的 runner 中（`runner/`），服务端这里**不再有 pi 的 Agent**。服务端留下的：
 * Y.Doc 与画布工具的执行（runner 的工具只是 `/canvas/tool` 的代理，这里用同一份 `tools.ts` 在直连的房间上执行）、
 * 常驻观察与跨轮差异（要读文档）、run 注册表 / 补发缓冲 / SSE / 广播、落库（会话、运行日志、工具调用日志）、
 * 判权与对账、真实的 LLM key（网关的模型代理注入）。runner 被杀在任何一步都合法：
 *
 * - **事件**：runner 把 pi 事件裁成 `RunnerEvent` 上报，这里原样喂给 `events.ts` 的映射器 —— 映射只在服务端，
 *   所以 runner 被杀之后，收尾帧（关文字段、把还在转的工具标成「已中止」）和落库的 assistant 消息照样由这里补齐；
 * - **模型上下文**：由上报的 `message_end` 按顺序重建（= pi 的 `agent.state.messages`）；被杀时最后一批工具调用
 *   缺的结果补成「已中止」的错误结果，下一轮的上下文才合法；
 * - **工具调用日志**：画布工具以网关的执行记录为准（runner 在不可信区，它报的成败不算数）；
 *   只在 runner 里跑的媒体工具按它上报的记；
 * - **每一轮的上限**都在这里：步数（数上报的 `turn_end`）、工具调用次数（runner 先拦，网关按同一个数硬拦）、
 *   时长、删除预算（服务端的工具实例）、补发缓冲。
 *
 * **叫停 = 作废令牌 + 杀沙箱**：中止、超时、失权、步数超限、进程退出都走 {@link stopRun} → `interrupt`：
 * 先 `close()` 网关上的登记（之后这一轮的任何请求 401、在途的上游模型请求掐断），再让驱动立即杀掉沙箱，
 * 然后等它退出、照常走第 4、5 步。沙箱没报收尾就退出了（崩溃）→ 这一轮以 RUN_ERROR 收尾、写明原因。
 *
 * **运行日志 fail open**：它是旁路记录，`startRun` / `recordToolCall` / `finishRun` 写失败只 console.error，
 * 不影响这一轮 —— 让一次审计写入的失败把画布操作打断，是本末倒置。会话的 save 则相反（见第 4 步），
 * 因为对话本身就是用户看得见的东西。
 *
 * ## 一轮不随发起它的连接存亡
 *
 * 能让一轮停下的只有：{@link AgentRuntime.abort}（发起人或项目管理员点停止）、时长上限（`timeoutMs`）、
 * **Grant 失效**（见下）、进程退出（{@link AgentRuntime.abortAll}）。
 * **客户端断开不在其中**：关页面、刷新、断网只是少了一个订阅者，这一轮照常跑完、照常落库，
 * 重新打开画布的人可以用 {@link AgentRuntime.subscribe} 接回去。**发起人的登录态也不在其中**：
 * 一轮凭的是开始时签发的 Grant，不是会话 —— 退出登录、会话过期都不影响它（docs/22 §6）。
 *
 * ## 执行身份：Grant 与 authorize（docs/22 §3、§5，`authority.ts`）
 *
 * 开画布之前向宿主 `issue` 一份 Grant（{@link AgentRuntimeOptions.authorities}），之后每一项能力用之前都判一次：
 * 每个画布工具在网关上执行之前判它声明的 `capability`（这里统一包一层，工具自己不调）；每次模型请求经网关的
 * 模型代理时判 `llm:invoke`（判过了才注入真实 key）；画布每次读写由宿主的画布实现按 `flow:read` / `flow:write` 判
 * （`openCanvas` 拿到的是同一份 authority）。`sandbox:exec` 只决定提不提供要它的技能（`media-exec`）：那些工具在 runner
 * 自己的工作目录里跑，不经网关（docs/22 §3「沙箱内部动作」）。网关**从不读令牌里的 scope**。
 *
 * ## 技能（docs/23）
 *
 * 工具按技能组织（`skills/`，runner 和这里从同一份注册表构造）。一轮开始时按 Grant + 部署条件 + 用户消息里的提及算出
 * **提供**哪些、**一开始就加载**哪些（`registry.plan`）；其余进系统提示的技能目录，模型 `load_skill` 加载。
 * 网关执行工具前有两道独立的检查：工具所属的技能本轮**已加载**（runner 不可信，可能直接点名没加载的），
 * 再判工具声明的能力。会话记着加载过的技能（只增不减），下一轮仍提供就预加载。
 * **判权因 Grant 失效而失败 = 整轮立即停**（`on_revoke: stop`），以 cancelled（到期是 expired）收尾、写明原因 ——
 * 不是只回给模型一个工具错误。宿主对账发现失效时也经 `stop` 回调主动叫停，不必等下一次工具调用。
 * 签发不出来（发起时就已失权）→ 这一轮以 RUN_ERROR 收尾，不调模型。收尾时 `release` 关掉 Grant。
 * 已经写进画布的改动**保留**：每次工具调用是独立的 Y 事务，中止不回滚（撤回本轮是后续需求，§3.5）。
 * 中止之后照样走第 4、5 步 —— 被中止的一轮也是对话的一部分。
 *
 * ## 画布只开一次，别人的改动插进来（docs/20 §3.10.2）
 *
 * 一轮从开始到收尾只调一次 `openCanvas`（宿主那边是一条常驻的 direct connection），收尾时 `close()` ——
 * 成功 / 中止 / 出错 / 进程退出都走第 5 步。工具每次读写照样经 `CanvasHandle`，宿主每次都重查权限与配额。
 *
 * 开画布时挂上常驻观察（`canvas-changes.ts` 的 {@link createCanvasWatch}）：
 * - 本轮自己的写入不报；别的轮次报成「某某 的 agent」，人报成他自己，认不出的报成「其他协作者」；
 * - 改动按 `changeWindowMs` 合并成一条通知，排队；**只在一批调过工具的 turn_end（下一次请求模型之前）**
 *   由 runner 来取（`/canvas/changes`：先把窗口里攒着的冲掉，排着的并成一条），runner 把它 `steer()` 进去 ——
 *   模型正在写最终回复时到的改动不交出去（否则 pi 会为它再开一轮），留给跨轮差异；这条时机规则由 runner 执行；
 * - 那条消息真正进入模型上下文（runner 上报 pi 的 message_end，带着这条通知的 `steerId`）时，
 *   发 CUSTOM `agent.canvas-change`、记进对话记录；
 * - 收尾时存一份画布摘要（没交给模型的通知涉及的元素退回改动之前），下一轮开始时对比，
 *   有差异就把「自你上次运行以来画布的变化」放在这一轮的用户消息前面，并同样发一条通知。
 *
 * ## 事件：一份缓冲，多个订阅者
 *
 * 一轮发出的每一帧都经同一个 `publish`：先追加进这一轮的**补发缓冲**，再按顺序交给每个订阅者。
 * 发起者（`start()` 的 `emit`）就是第一个订阅者，在第一帧之前就挂上了；后来的订阅者
 * （{@link AgentRuntime.subscribe}）先同步收到缓冲里的全部帧，再接着收后续的 —— 补发和实时推之间
 * 没有 await，不会漏帧也不会重帧。所以**两条路看到的序列逐帧相同**，包括「会话没准备好、
 * 只发了一帧 RUN_ERROR」那种：那一帧同样进缓冲，准备会话那几毫秒里接回的人收到的也只有它；
 * 它发完这一轮就结束了，之后没有可接回的东西。
 *
 * 缓冲有上限（`replayEvents` 条 / `replayChars` 字）：超出就标记溢出、丢掉缓冲、不再缓冲，
 * 已经挂着的订阅者照常实时收；之后再来接回的得到 `overflowed`（路由回 410）。
 * 最后一帧（RUN_FINISHED / RUN_ERROR）发出后通知订阅者「完了」；这一轮从 `runs` 删掉时缓冲随之释放。
 * 最后一帧之后、删掉之前（关画布、写运行日志那一小段）接回的，补发里就带着最后一帧，随即完结 ——
 * 只要任务列表里还看得见它，就接得回。
 */

export interface RunLimits {
  /** 一轮里最多几次「模型回复」（每次调工具之后模型都要再回一次） */
  maxTurns: number
  /** 一轮里最多几次工具调用，超出的被拦下并告诉模型 */
  maxToolCalls: number
  /** 一轮的总时长 */
  timeoutMs: number
  /** 一个会话的对话记录（给前端的）最多留几条 */
  chatMessages: number
  /** 一个会话的模型上下文（pi 的 messages）最多留几条；裁剪在用户消息的边界上，不拆开工具调用与结果 */
  llmMessages: number
  /** 补发缓冲最多存几帧 */
  replayEvents: number
  /** 补发缓冲最多存多少字（各帧 JSON 的字符数之和） */
  replayChars: number
  /** 画布改动的合并窗口（毫秒）：第一处改动之后等这么久合并成一条通知（docs/20 §3.10.2） */
  changeWindowMs: number
  /** 一条画布改动通知最多列几处 */
  changeItems: number
  /** 一条画布改动通知列出来的条目最多多少字 */
  changeChars: number
  /** 一轮里模型最多 `load_skill` 成功几次（docs/23 §3.3，防反复加载） */
  maxSkillLoads: number
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxTurns: 24,
  maxToolCalls: 60,
  timeoutMs: 5 * 60_000,
  chatMessages: 200,
  llmMessages: 120,
  /*
   * 补发缓冲的上限。按「一轮自己的上限」估：60 次工具调用 × 每次的参数（正文上限 8000 字）
   * + 结果（TOOL_RESULT_CONTENT_LIMIT 8000 字）≈ 百万字，再加上文字回复，2M 字装得下正常跑满的一轮；
   * 条数主要防「每个 token 一帧 TEXT_MESSAGE_CONTENT」的提供方：24 步、每步几百个 token 也到不了一万。
   * 这是**每一轮**的上限：同一张画布上可以同时跑多轮（每个会话一轮），所以一张画布的总量是它乘以在跑的轮数 ——
   * 每用户 / 每画布的并发上限只做规划（docs/20 §3.10.6）。真超了只是不能接回（410），这一轮照常跑。
   */
  replayEvents: 10_000,
  replayChars: 2_000_000,
  changeWindowMs: 1500,
  changeItems: 20,
  changeChars: 2000,
  maxSkillLoads: 3,
}

/** 会话 id 的长度上限 —— 只是挡住乱给的参数，真正的校验是查库 */
export const AGENT_CONVERSATION_ID_MAX_LENGTH = 128

/** 工具调用日志里 error 的长度上限 */
const TOOL_ERROR_LOG_LIMIT = 500

/** 打开的画布：宿主实现，**一轮开一次**、收尾时关（释放 direct connection，触发落库） */
export interface OpenedCanvas extends CanvasHandle {
  close(): Promise<void>
}

export interface AgentRuntimeOptions {
  /** `null` = 没配模型，agent 未启用 */
  model: ResolvedAgentModel | null
  /** 未启用时给人看的原因（日志 / 503 的 message） */
  disabledReason?: string
  /** 会话持久化。**必填**：没有默认实现，免得「忘了接库」悄悄变成「重启即丢」 */
  store: AgentConversationStore
  /** 运行日志。必填，理由同上 */
  runLog: AgentRunLog
  /**
   * 一批用户的展示信息（会话 / 任务的 `owner`）。必填，理由同上：宿主才认识用户表
   * （apps/server 用 `store/users.ts`，名字的取值顺序与协同层在场信息一致）。
   * 查不到的人可以不在返回的 Map 里，编排层兜底成「匿名用户」；**不要带邮箱以外的私密字段，也不要带邮箱**。
   */
  userProfiles: (userIds: string[]) => Promise<Map<string, AgentUserView>>
  /**
   * 一张画布的运行中任务列表变了（一轮进了列表 / 离开列表）。给的是这张画布**当前的全量列表**，
   * 宿主拿去经协同房间广播（docs/20 §3.10.4）。同步调用；抛错只记日志，不影响这一轮。
   */
  onRunsChange?: (flowId: string, runs: AgentRunEntry[]) => void
  /**
   * 每一轮起一个沙箱跑 runner（docs/22 §7）。**必填**，理由同 `store`：没有「在服务端进程里跑 pi」的默认值。
   * 宿主用 `process` 驱动（`@shadecn/agent/sandbox/drivers`）；测试用进程内的那个（`@shadecn/agent/testing`）。
   */
  driver: SandboxDriver
  /** 网关：沙箱看到的地址、令牌密钥、打上游模型用的 fetch */
  gateway: AgentGatewayConfig
  /**
   * 开沙箱里的命令执行（技能 `media-exec`：ffmpeg / ffprobe 在 runner 的工作目录里跑）；开了才向 Grant 要 `sandbox:exec`，
   * 还要 Grant 里真有它才提供这个技能（部署条件 `sandboxExec`）
   */
  mediaTool?: boolean
  /**
   * 读节点素材的字节（宿主实现，只读它自己的对象存储，`media.ts`）。给了、**且模型支持图片输入**
   * （`model.input` 含 `image`）时才提供技能 `media-view`；判权同其余读工具（`flow:read`，在网关上判）。
   */
  mediaReader?: MediaReader
  /**
   * 技能注册表（docs/23）。不给用内置的 {@link BUILTIN_SKILLS}；测试注册自己的技能时给，
   * 并且**必须**把同一个注册表交给 runner（进程内驱动的 `skills`）—— 两侧从同一份构造工具。
   */
  skills?: SkillRegistry
  /** 沙箱镜像与资源上限（`process` 驱动只用 `deadlineMs`；不给按一轮的时长上限 + 30 秒） */
  sandbox?: { image?: string; resources?: Partial<SandboxResources> }
  /**
   * 每一轮的执行身份（Grant 签发与判权，`authority.ts`）。**必填**，理由同 `store`：
   * 没有「全放行」的默认值，忘了接就编译不过，而不是悄悄变成谁都能写。
   */
  authorities: RunAuthorityProvider
  limits?: Partial<RunLimits>
}

export interface AgentGatewayConfig {
  /** 沙箱里看到的网关地址（含 `AGENT_GATEWAY_PATH`），交给 runner */
  url: string
  /** 签 run 短令牌的密钥（只在服务端） */
  secret: string | Uint8Array
  /** 网关打上游模型用的 fetch；不给用调用那一刻的 `globalThis.fetch`（测试注入脚本化的上游） */
  upstreamFetch?: typeof fetch
}

export interface StartRunInput {
  flowId: string
  userId: string
  /** 已校验过的用户输入（见 {@link validatePrompt}） */
  text: string
  /**
   * 发到哪个会话；`null` = 新会话。宿主应先用 {@link AgentRuntime.getConversation} 确认它存在
   * （状态码只能在开流之前定）；在那之后才被删掉的，这一轮以 RUN_ERROR 收尾。
   */
  conversationId: string | null
  /**
   * 会话的入口节点（docs/20 §3.10.9）：**只在新会话（`conversationId: null`）时用**，写进新建的会话；
   * 续聊时以会话里存的为准，这里给的被忽略。宿主应先确认这个节点在这张画布上（404 只能在开流之前定）。
   * 只是记下来：不限制工具、不触发技能加载（加载看消息里的提及）。
   */
  nodeId?: string | null
  /**
   * 打开这张画布（一轮只调一次，收尾时 `close()`）。配额、房间连接是宿主的事；
   * **每次读写之前用给的 `authority` 判 `flow:read` / `flow:write`**（它判失败时这一轮已经被叫停）。
   */
  openCanvas: (runId: string, authority: RunAuthority) => Promise<OpenedCanvas>
  /**
   * 发起者这个订阅者：在第一帧之前挂上，收到的序列与之后任何 {@link AgentRuntime.subscribe} 一致。
   * 宿主连接断了就调返回的 `unsubscribe` —— **断开不中止这一轮**。
   */
  emit: (event: AgentStreamEvent) => void
}

export type StartRunResult =
  | {
      ok: true
      runId: string
      /** 这一轮彻底结束（最后一帧发出、画布关掉、运行日志写完） */
      done: Promise<void>
      /** 发起者不再收事件（连接断了）；这一轮照常跑 */
      unsubscribe: () => void
    }
  /** `busy` = 这个会话已经有一轮在跑（别的会话不影响） */
  | { ok: false; reason: 'disabled' | 'busy'; message: string }

export type SubscribeResult =
  | {
      ok: true
      /** 最后一帧已交给这个订阅者，或它已退订 */
      done: Promise<void>
      unsubscribe: () => void
    }
  /** 不是这张画布上正在跑的一轮（已结束 / runId 不对 / 在别的画布上） */
  | { ok: false; reason: 'not-found' }
  /** 补发缓冲溢出了，接不回完整序列 */
  | { ok: false; reason: 'overflowed' }

export type AbortResult = 'aborted' | 'not-running' | 'forbidden'
/** `forbidden` = 是这张画布上的会话，但不是请求者的（只读可见，删不得） */
export type DeleteConversationResult = 'deleted' | 'running' | 'not-found' | 'forbidden'

/** 谁在中止：发起人本人，或项目管理员（宿主按请求者在项目里的角色给 `admin`，每次请求重查） */
export interface AbortActor {
  userId: string
  admin: boolean
}

export interface AgentRuntime {
  readonly enabled: boolean
  /** 网关：宿主把它挂在 `AGENT_GATEWAY_PATH` 下（会话登录那道闸之外，只认 run 短令牌） */
  readonly gateway: { handle(request: Request): Promise<Response> }
  readonly modelLabel: string | null
  readonly disabledReason: string | null
  /** `userId` 是请求者：决定 `mine` 和默认打开哪个会话 */
  view(flowId: string, userId: string): Promise<AgentSessionView>
  /** 这张画布此刻在跑、已进列表的轮次（全量，按 startedAt 升序）—— 广播与 `view` 用的是同一份 */
  activeRuns(flowId: string): AgentRunEntry[]
  /** 这张画布上所有人的会话（`userId` 只用来算 `mine`）；能不能进这张画布由宿主判 */
  listConversations(flowId: string, userId: string): Promise<AgentConversationSummary[]>
  /** 这张画布上的一个会话，不论是谁的（只读）；不在这张画布上 → null */
  getConversation(flowId: string, userId: string, id: string): Promise<AgentConversationView | null>
  /** 只有发起人能删；这个会话正在跑一轮时拒绝 */
  deleteConversation(flowId: string, userId: string, id: string): Promise<DeleteConversationResult>
  /** 这张画布上有没有任何一轮在跑（含还没进列表、正在准备会话的） */
  isRunning(flowId: string): boolean
  start(input: StartRunInput): StartRunResult
  /**
   * 接回 / 旁观一轮：只要是这张画布此刻在跑的那一轮。谁能看由宿主判（能进这张画布的人都能看，只读）。
   * 先**同步**补发自第一帧起的全部事件，再推后续的；最后一帧之后 `done` 兑现。返回之前补发就已经发完了。
   */
  subscribe(flowId: string, runId: string, onEvent: (event: AgentStreamEvent) => void): SubscribeResult
  /** 中止这张画布上的某一轮：只有发起人或项目管理员能中止 */
  abort(flowId: string, runId: string, actor: AbortActor): AbortResult
  /**
   * 进程退出前：中止所有在跑的轮次，并等它们收尾（对话落库、运行日志写完、画布关掉）。
   * 宿主要在关数据库之前 await 它（给个上限）。
   */
  abortAll(reason: string): Promise<void>
  /** 此刻在本进程里的全部轮次（含还在准备的）：宿主拿去给驱动的 `reap`，免得把在跑的当孤儿 */
  liveRunIds(): ReadonlySet<string>
}

export type ValidatedPrompt =
  | { ok: true; text: string; conversationId: string | null; nodeId: string | null }
  | { ok: false; error: string }

/** 节点 id 的格式：同提及 `@{node:<id>}` 认的字符集 */
const NODE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/

/** `POST …/messages` 的请求体校验；路由直接用 */
export function validatePrompt(body: unknown): ValidatedPrompt {
  const raw = (body as { text?: unknown } | null)?.text
  if (typeof raw !== 'string') return { ok: false, error: 'text 必须是字符串' }
  const text = raw.trim()
  if (!text) return { ok: false, error: 'text 不能为空' }
  if (text.length > AGENT_PROMPT_MAX_LENGTH) {
    return { ok: false, error: `text 超过 ${AGENT_PROMPT_MAX_LENGTH} 字` }
  }

  const rawNodeId = (body as { nodeId?: unknown }).nodeId
  let nodeId: string | null = null
  if (rawNodeId !== undefined && rawNodeId !== null) {
    if (typeof rawNodeId !== 'string' || !NODE_ID_REGEX.test(rawNodeId)) {
      return { ok: false, error: 'nodeId 必须是合法的节点 id 或 null' }
    }
    nodeId = rawNodeId
  }

  const conversationId = (body as { conversationId?: unknown }).conversationId
  if (conversationId === undefined || conversationId === null) return { ok: true, text, conversationId: null, nodeId }
  if (typeof conversationId !== 'string' || !conversationId) {
    return { ok: false, error: 'conversationId 必须是非空字符串或 null' }
  }
  if (conversationId.length > AGENT_CONVERSATION_ID_MAX_LENGTH) {
    return { ok: false, error: `conversationId 超过 ${AGENT_CONVERSATION_ID_MAX_LENGTH} 字` }
  }
  // 入口节点只在建会话时记下（docs/20 §3.10.9）：续聊时再给一个，是想改它 —— 不支持
  if (nodeId !== null) return { ok: false, error: 'nodeId 只能在新建会话时给（续聊不能改入口节点）' }
  return { ok: true, text, conversationId, nodeId: null }
}

interface Subscriber {
  onEvent: (event: AgentStreamEvent) => void
  complete: () => void
}

interface RunState {
  runId: string
  flowId: string
  userId: string
  /** UTC epoch 毫秒 */
  startedAt: number
  /** 新会话在准备好之前是 null —— 那时也没人知道它的 id，删不到它、也撞不上它 */
  conversationId: string | null
  /** 会话标题（列表里给人看的）；准备好会话时定下 */
  conversationTitle: string
  /** 会话的入口节点（docs/20 §3.10.9）；没有入口、会话还没准备好时为 null */
  nodeId: string | null
  /** 发起人的展示信息；进列表之前查好 */
  owner: AgentUserView | null
  /** RUN_STARTED 已发出、已进运行中任务列表（见文件头「运行中任务列表」） */
  listed: boolean
  /** 第一个要求停下的原因与收尾状态（先到先得，见 {@link stopRun}）；没人要求停为 null */
  stopped: { reason: string; status: StopStatus } | null
  /** 让正在跑的那一步停下：网关登记之前是空操作（起沙箱之前会看 `stopped`），之后是「作废令牌 + 杀沙箱」 */
  interrupt: () => void
  done: Promise<void>
  /** 自第一帧起发出的全部事件；溢出后为 null（不再缓冲） */
  replay: AgentStreamEvent[] | null
  replayChars: number
  /** 最后一帧（RUN_FINISHED / RUN_ERROR）已经发出 */
  finished: boolean
  subscribers: Set<Subscriber>
}

/** 被叫停的一轮以什么状态收尾：Grant 到期是 expired，其余（停止按钮、超时、失权、进程退出）是 cancelled */
type StopStatus = 'cancelled' | 'expired'

/** 叫停一轮：记下第一个原因（之后的不覆盖），并让正在跑的那一步停下。幂等 */
function stopRun(run: RunState, reason: string, status: StopStatus = 'cancelled') {
  run.stopped ??= { reason, status }
  run.interrupt()
}

function stoppedOutcome(stopped: { reason: string; status: StopStatus }): RunOutcome {
  return stopped.status === 'expired'
    ? { type: 'expired', reason: stopped.reason }
    : { type: 'cancelled', reason: stopped.reason }
}

/** 一轮向宿主要的能力；宿主按发起人此刻的权限与服务端配置取交集（docs/22 §5） */
function requestedCapabilities(media: boolean): AgentCapability[] {
  return ['flow:read', 'flow:write', 'flow:delete', 'llm:invoke', ...(media ? (['sandbox:exec'] as const) : [])]
}

/** 令牌里那串给人看的 scope（docs/22 §3 的写法）；网关不读它 */
function scopeText(scopes: ReadonlySet<AgentCapability>, flowId: string): string {
  return [...scopes].map((cap) => (cap.startsWith('flow:') ? `flow:${flowId}:${cap.slice('flow:'.length)}` : cap)).join(' ')
}

/** 交给 runner 的模型描述：去掉真实地址和可能带凭据的 headers（网关注入） */
function runnerModelOf(model: Model<Api>): RunnerModel {
  const copy: Partial<Model<Api>> = { ...model }
  delete copy.baseUrl
  delete copy.headers
  return copy as RunnerModel
}

/** 被杀时最后一批工具调用缺的结果：补成错误结果，下一轮的上下文才合法（各家 API 都拒「有调用没结果」） */
const TOOL_INTERRUPTED = '这一轮在这次工具调用完成之前被停止，结果未知；需要时请重新读取画布确认'

export function completeToolResults(messages: AgentMessage[]): AgentMessage[] {
  let index = messages.length - 1
  while (index >= 0 && messages[index]!.role !== 'assistant') index -= 1
  const assistant = messages[index]
  if (!assistant || assistant.role !== 'assistant' || assistant.stopReason !== 'toolUse') return messages
  const calls = assistant.content.filter((part): part is ToolCall => part.type === 'toolCall')
  const answered = new Set(
    messages.slice(index + 1).flatMap((message) => (message.role === 'toolResult' ? [message.toolCallId] : [])),
  )
  const missing = calls.filter((call) => !answered.has(call.id))
  if (missing.length === 0) return messages
  const now = Date.now()
  return [
    ...messages,
    ...missing.map(
      (call): ToolResultMessage => ({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: TOOL_INTERRUPTED }],
        isError: true,
        timestamp: now,
      }),
    ),
  ]
}

/** 沙箱没报收尾就退出了：给人看的原因 */
function runnerFailure(exit: SandboxExit | null): string {
  if (!exit) return 'agent 运行环境没有起来'
  const how = exit.exitCode !== null ? `退出码 ${exit.exitCode}` : (exit.reason ?? '被结束')
  return `agent 运行环境异常退出（${how}${exit.exitCode !== null && exit.reason ? `，${exit.reason}` : ''}），这一轮没有完成`
}

/** 协议版本对不上（沙箱镜像没跟着服务端重建）：给人看的原因 */
function protocolMismatchMessage(info: { runnerVersion: number | null; serverVersion: number }): string {
  const runner = info.runnerVersion === null ? '未声明（镜像过旧）' : String(info.runnerVersion)
  return `沙箱 runner 的协议版本 ${runner} 和服务端的 ${info.serverVersion} 不一致，请重建沙箱镜像（pnpm build:sandbox-image）`
}

/** runner 收尾（`/run/finish`）之后最多等它自己退出多久，过了就杀 */
const RUNNER_EXIT_GRACE_MS = 5000
/** 沙箱存活的兜底上限比一轮的时长上限多这么多 */
const SANDBOX_DEADLINE_MARGIN_MS = 30_000

/** 网关代执行过的一次画布工具调用（审计以它为准） */
interface ExecutedCall {
  name: string
  args: string
  ok: boolean
  elementIds: string[]
  error: string | null
  durationMs: number
  at: number
}

/** 工具执行之前先判它声明的能力（判失败时 authority 已经把这一轮叫停了，这里把错误回给模型） */
function authorizedTool(tool: CanvasTool, authority: RunAuthority): CanvasTool {
  return {
    ...tool,
    async execute(toolCallId, args, signal, onUpdate) {
      await authority.authorize(tool.capability)
      return tool.execute(toolCallId, args, signal, onUpdate)
    },
  }
}

const isTerminal = (event: AgentStreamEvent) =>
  event.type === AgentEventType.RUN_FINISHED || event.type === AgentEventType.RUN_ERROR

/** 工具日志里的参数摘要：id 类字段照写，字符串只记长度 —— 不把用户内容写进日志 */
const ID_KEYS = new Set([
  'id',
  'ids',
  'source',
  'target',
  'connectFrom',
  'sourcePort',
  'targetPort',
  'type',
  'command',
])

export function digestArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (ID_KEYS.has(key) && typeof value === 'string') parts.push(`${key}=${value}`)
    else if (ID_KEYS.has(key) && Array.isArray(value)) parts.push(`${key}=[${value.slice(0, 20).join(',')}]`)
    else if (typeof value === 'string') parts.push(`${key}(${value.length}字)`)
    else if (Array.isArray(value)) parts.push(`${key}[${value.length}]`)
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${key}=${value}`)
    // 按组传的对象（metadata / data）只记**字段名**，值一个字都不记
    else if (typeof value === 'object' && value !== null) parts.push(`${key}{${Object.keys(value).slice(0, 20).join(',')}}`)
    else if (value !== undefined) parts.push(key)
  }
  return parts.join(' ')
}

/**
 * 裁剪模型上下文：留最后 `max` 条，**切口落在一条用户消息上** ——
 * 从中间切开会留下一个没有对应 tool_use 的 tool_result，各家 API 都会拒。
 */
export function trimLlmHistory(messages: AgentMessage[], max: number): AgentMessage[] {
  if (messages.length <= max) return messages
  for (let index = messages.length - max; index < messages.length; index += 1) {
    if (messages[index]?.role === 'user') return messages.slice(index)
  }
  // 最近 max 条里一条用户消息都没有（一轮里工具调用极多）：宁可清空也不留半截
  return []
}

/** 对话记录只留最后 `max` 条（前端看的，没有配对约束，直接切） */
function trimChat(messages: AgentChatMessage[], max: number): AgentChatMessage[] {
  return messages.length > max ? messages.slice(messages.length - max) : messages
}

/**
 * 截到 `max` 字（含末尾的省略号）。不切开代理对，也不切开一个 `@{node:<id>}` ——
 * 半截提及在前端会显示成一串乱码，宁可整个丢掉。
 */
function clipText(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  let head = chars.slice(0, max - 1).join('')
  const open = head.lastIndexOf('@{')
  if (open !== -1 && !head.includes('}', open)) head = head.slice(0, open)
  return `${head.trimEnd()}…`
}

/** 会话标题：首条用户消息的开头，原文（提及保留，前端按提及渲染），空白折成一个空格 */
export function conversationTitle(text: string): string {
  return clipText(text.replace(/\s+/g, ' ').trim(), AGENT_TITLE_MAX_LENGTH)
}

/** 把模型回复压成一行纯文本：去掉 markdown 的记号，提及换成「@节点」（这里没有画布可查名字） */
function plainText(text: string): string {
  return text
    // 全局正则交给 replace 是安全的：它从头扫、不受 lastIndex 残留影响
    .replace(NODE_MENTION_PATTERN, '@节点')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 会话摘要：最近一条 assistant 消息的开头（纯文本）。
 * 它只调了工具、没说话时，拿工具调用的那几句话顶上；再没有就是出错说明；还没有 assistant 消息时为空串。
 */
export function conversationSummary(messages: AgentChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'assistant') continue
    const text =
      plainText(message.text) ||
      message.toolCalls.map((call) => call.summary).join('；') ||
      (message.error ?? '')
    return clipText(text, AGENT_SUMMARY_MAX_LENGTH)
  }
  return ''
}

/** 落库的 pi messages 是外部数据：不是数组就当没有（坏数据丢的只是上下文，不值得让这一轮失败） */
function asLlmMessages(value: unknown): AgentMessage[] {
  return Array.isArray(value) ? (value as AgentMessage[]) : []
}

function conversationGone(): AgentStreamEvent {
  return {
    type: AgentEventType.RUN_ERROR,
    message: '这个会话不存在或已被删除',
    code: 'conversation_not_found',
    timestamp: Date.now(),
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 查不到这个人（已被删）时的兜底，名字与 apps/server `displayNameOf` 的兜底一致 */
function unknownUser(id: string): AgentUserView {
  return { id, name: '匿名用户', avatarUrl: null }
}

/** 同一个会话的槽位键：会话 id 本身全局唯一，带上画布只是让「别的画布的 id」永远撞不上 */
const conversationKey = (flowId: string, conversationId: string) => `${flowId}\n${conversationId}`

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const limits: RunLimits = { ...DEFAULT_RUN_LIMITS, ...options.limits }
  // 模型请求要经网关的模型代理：代理不了的线协议 = agent 没开（而不是每一轮都失败）
  const unproxied =
    options.model && !isProxiedModelApi(options.model.model.api)
      ? `模型的线协议 ${options.model.model.api} 暂不支持经网关代理（支持：${PROXIED_MODEL_APIS.join(' / ')}）`
      : null
  const resolved = unproxied ? null : options.model
  const disabledReason = unproxied ?? options.disabledReason ?? '没有配置模型'
  const { store, runLog } = options
  /** 技能注册表：runner 那边用的必须是同一份（生产都是内置的，测试显式传同一个） */
  const registry = options.skills ?? BUILTIN_SKILLS
  const gateway = createAgentGateway({
    secret: options.gateway.secret,
    upstream: resolved ? { model: resolved.model, apiKey: resolved.apiKey } : null,
    ...(options.gateway.upstreamFetch ? { fetch: options.gateway.upstreamFetch } : {}),
  })
  const sandboxResources: SandboxResources = {
    cpu: 1,
    memoryMiB: 512,
    pids: 64,
    diskMiB: 512,
    deadlineMs: limits.timeoutMs + SANDBOX_DEADLINE_MARGIN_MS,
    ...options.sandbox?.resources,
  }
  /** runId → 正在跑的一轮（含还在准备会话的）。进程内存，多副本不共享（见文件头） */
  const runs = new Map<string, RunState>()
  /** 会话的槽位：`conversationKey` → 在它上面跑的那一轮。一个会话同时只跑一轮 */
  const busyConversations = new Map<string, RunState>()

  const isConversationRunning = (flowId: string, id: string) => busyConversations.has(conversationKey(flowId, id))

  async function profiles(userIds: string[]): Promise<Map<string, AgentUserView>> {
    const unique = [...new Set(userIds)]
    if (unique.length === 0) return new Map()
    try {
      return await options.userProfiles(unique)
    } catch (err) {
      // 名字头像查不到不该让面板打不开：兜底成「匿名用户」，记一笔
      console.error('[agent] 查询用户信息失败', err)
      return new Map()
    }
  }

  function entryOf(run: RunState): AgentRunEntry | null {
    if (!run.listed || run.conversationId === null) return null
    return {
      runId: run.runId,
      conversationId: run.conversationId,
      conversationTitle: run.conversationTitle,
      owner: run.owner ?? unknownUser(run.userId),
      startedAt: run.startedAt,
      // 只有带入口节点的会话才带（导演台暂时据它显示「正在编辑」，之后由占用替换）
      ...(run.nodeId ? { nodeId: run.nodeId } : {}),
    }
  }

  function activeRuns(flowId: string): AgentRunEntry[] {
    const entries: AgentRunEntry[] = []
    for (const run of runs.values()) {
      if (run.flowId !== flowId) continue
      const entry = entryOf(run)
      if (entry) entries.push(entry)
    }
    return entries.sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : 1))
  }

  /** 画布改动是谁做的 → 显示名；`null` = 本轮自己的写入，不报 */
  function actorName(actor: CanvasActor, ownRunId: string): string | null {
    if (actor.kind === 'agent') {
      if (actor.runId === ownRunId) return null
      const other = runs.get(actor.runId)
      // 别的副本上的轮次这里不认识（注册表在进程内存，F14）
      return other ? `${other.owner?.name ?? unknownUser(other.userId).name} 的 agent` : '另一个 agent'
    }
    if (actor.kind === 'user') return actor.name || '其他协作者'
    return '其他协作者'
  }

  /** 列表变了：把这张画布的全量列表交给宿主（广播）。宿主的错不该打断这一轮 */
  function notifyRunsChange(flowId: string) {
    if (!options.onRunsChange) return
    try {
      options.onRunsChange(flowId, activeRuns(flowId))
    } catch (err) {
      console.error(`[agent] flow=${flowId} 任务列表变更通知失败`, err)
    }
  }

  /** 占住会话的槽位（同步）；已被占 → false */
  function claimConversation(run: RunState, conversationId: string): boolean {
    const key = conversationKey(run.flowId, conversationId)
    const holder = busyConversations.get(key)
    if (holder && holder !== run) return false
    busyConversations.set(key, run)
    return true
  }

  function releaseConversation(run: RunState) {
    if (run.conversationId === null) return
    const key = conversationKey(run.flowId, run.conversationId)
    if (busyConversations.get(key) === run) busyConversations.delete(key)
  }

  function deliver(subscriber: Subscriber, event: AgentStreamEvent) {
    try {
      subscriber.onEvent(event)
    } catch (err) {
      // 一个订阅者写不出去（连接已断）不该打断这一轮，也不该连累别的订阅者
      console.warn('[agent] 事件发送失败', err)
    }
  }

  /** 一轮的每一帧都从这里出去：先进补发缓冲，再按顺序交给每个订阅者（见文件头） */
  function publish(run: RunState, event: AgentStreamEvent) {
    if (run.finished) {
      console.warn(`[agent] run=${run.runId} 最后一帧之后还有事件（${event.type}），丢弃`)
      return
    }
    if (run.replay) {
      const chars = JSON.stringify(event).length
      if (run.replay.length >= limits.replayEvents || run.replayChars + chars > limits.replayChars) {
        console.warn(
          `[agent] run=${run.runId} 补发缓冲超过上限（${run.replay.length} 帧 / ${run.replayChars} 字），之后不能再接回`,
        )
        run.replay = null
        run.replayChars = 0
      } else {
        run.replay.push(event)
        run.replayChars += chars
      }
    }
    const terminal = isTerminal(event)
    if (terminal) run.finished = true
    for (const subscriber of [...run.subscribers]) deliver(subscriber, event)
    if (terminal) {
      for (const subscriber of run.subscribers) subscriber.complete()
      run.subscribers.clear()
    }
  }

  function subscriberOf(onEvent: (event: AgentStreamEvent) => void) {
    let complete!: () => void
    const done = new Promise<void>((resolve) => (complete = resolve))
    const subscriber: Subscriber = { onEvent, complete }
    return { subscriber, done }
  }

  function summaryOf(
    row: StoredConversationMeta,
    viewerId: string,
    owners: Map<string, AgentUserView>,
  ): AgentConversationSummary {
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      messageCount: row.messageCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      owner: owners.get(row.userId) ?? unknownUser(row.userId),
      mine: row.userId === viewerId,
      running: isConversationRunning(row.flowId, row.id),
      nodeId: row.nodeId,
      skills: skillViews(row.skills),
    }
  }

  function skillViews(ids: readonly string[]): AgentSkillView[] {
    return canonicalSkillIds(ids).map((id) => ({ id, title: registry.titleOf(id) }))
  }

  async function viewOf(row: StoredConversation, viewerId: string): Promise<AgentConversationView> {
    return { ...summaryOf(row, viewerId, await profiles([row.userId])), messages: row.messages }
  }

  /** 旁路写入：失败只记一笔（见文件头「运行日志 fail open」） */
  function sideWrite(label: string, task: () => Promise<void>): Promise<void> {
    try {
      return task().catch((err: unknown) => console.error(`[agent] ${label}写入失败`, err))
    } catch (err) {
      console.error(`[agent] ${label}写入失败`, err)
      return Promise.resolve()
    }
  }

  async function execute(input: StartRunInput, run: RunState): Promise<void> {
    if (!resolved) return
    const { flowId, userId, text } = input
    const { startedAt } = run
    // 和准备会话并行：进列表之前要有发起人的名字头像
    const ownerLookup = profiles([userId]).then((found) => found.get(userId) ?? unknownUser(userId))

    const send = (events: AgentStreamEvent[]) => {
      for (const event of events) publish(run, event)
    }

    const userMessage: Extract<AgentChatMessage, { role: 'user' }> = {
      id: createId('msg'),
      role: 'user',
      text,
      createdAt: Date.now(),
    }

    // —— 1. 准备会话：用户消息先落库，再调模型 ——
    let conversationId: string
    let chat: AgentChatMessage[]
    let llmHistory: AgentMessage[]
    let previousSummary: string
    let title: string
    /** 上一轮结束时存的画布摘要；新会话 / 从没存过为 null（这一轮就没有跨轮差异） */
    let previousDigest: CanvasDigest | null = null
    /** 这个会话之前加载过的技能（只增不减，docs/23 §3.4） */
    let previousSkills: string[] = []
    /** 会话的入口节点（建会话时定下，只记录） */
    let nodeId: string | null
    try {
      if (input.conversationId === null) {
        chat = [userMessage]
        llmHistory = []
        previousSummary = ''
        title = conversationTitle(text)
        nodeId = input.nodeId ?? null
        const created = await store.create({
          flowId,
          userId,
          title,
          summary: '',
          messages: chat,
          llmMessages: [],
          nodeId,
        })
        conversationId = created.id
      } else {
        const existing = await store.getWithContext(flowId, userId, input.conversationId)
        if (!existing) {
          send([conversationGone()])
          return
        }
        conversationId = existing.id
        title = existing.title
        chat = trimChat([...existing.messages, userMessage], limits.chatMessages)
        llmHistory = asLlmMessages(existing.llmMessages)
        previousSummary = existing.summary
        previousDigest = existing.canvasDigest ?? null
        // 旧 id（`canvas-edit`）读出时换成现在的；最后那次 save 写回的并集里就只有新 id
        previousSkills = canonicalSkillIds(existing.skills)
        nodeId = existing.nodeId
        if (!(await store.save(flowId, userId, conversationId, { messages: chat, summary: previousSummary }))) {
          send([conversationGone()])
          return
        }
      }
    } catch (err) {
      console.error(`[agent] run=${run.runId} flow=${flowId} 会话没能保存，这一轮不开始`, err)
      send([
        {
          type: AgentEventType.RUN_ERROR,
          message: `对话没能保存，这一轮没有开始：${errorText(err)}`,
          code: 'persist_failed',
          timestamp: Date.now(),
        },
      ])
      return
    }
    // 新会话此刻才有 id：占上它的槽位（刚建好的会话没人知道 id，不可能被别人占着）
    if (input.conversationId === null) claimConversation(run, conversationId)
    run.conversationId = conversationId
    run.conversationTitle = title
    run.nodeId = nodeId
    run.owner = await ownerLookup

    // —— 2. 开始 ——
    /**
     * 这一轮**提供的**技能的全部工具 + `load_skill`：事件里那句话用它的 `describe`；网关执行的那些同时是网关代执行的那一份
     * （已包判权）。runner 执行的工具（`execution: 'runner'`）只有定义，网关拒绝代它执行。
     */
    const tools = new Map<string, CanvasTool>()
    /** 这一轮已加载的技能 id（一开始加载的 + `load_skill` 加载的）：网关只执行这些技能里的工具 */
    const loadedSkills = new Set<string>()
    /** 这一轮提供的技能 */
    const offeredSkills = new Map<string, AgentSkill>()
    /** 本轮 `load_skill` 成功的次数（`limits.maxSkillLoads`） */
    let skillLoads = 0
    const mapper = createRunEventMapper({
      threadId: conversationId,
      runId: run.runId,
      assistantMessageId: createId('msg'),
      describeTool: (name, args) => tools.get(name)?.describe(args as never) ?? name,
    })
    send(mapper.start(userMessage))
    // RUN_STARTED 发出去了：进运行中任务列表，告诉房间
    run.listed = true
    notifyRunsChange(flowId)
    console.info(
      `[agent] run=${run.runId} flow=${flowId} user=${userId} conversation=${conversationId} 开始（${text.length} 字）`,
    )

    const runStart: AgentRunStart = {
      runId: run.runId,
      conversationId,
      flowId,
      userId,
      model: resolved.label,
      grantId: null,
      startedAt,
    }
    // 签发 Grant 之后才写（要带上 grantId）；不 await，和开画布并行。结尾那笔 finishRun 会先等它，保证两笔的先后
    let runStarted: Promise<void> = Promise.resolve()
    const toolLogs: Promise<void>[] = []
    /** 这一轮的执行身份（签发成功之后才有）；包了一层：判权因 Grant 失效而失败时当场叫停这一轮 */
    let authority: RunAuthority | null = null

    let canvas: OpenedCanvas | null = null
    let watch: CanvasWatch | null = null
    const noticeLimits: NoticeLimits = { maxItems: limits.changeItems, maxChars: limits.changeChars }
    /** 合并好、还没交给 runner 的通知（按时间先后） */
    const queuedNotices: CanvasChangeNotice[] = []
    /** 已经交给 runner（它会 steer）、等 pi 把它放进上下文的那条 → 它对应的通知与对话里的那条 */
    const steered = new Map<string, { notice: CanvasChangeNotice; display: AgentCanvasChangeMessage }>()
    /** 对话记录里这一轮的通知：跨轮差异那条排在 assistant 之前，运行中的排在之后（和前端折叠的顺序一致） */
    let sinceLastRun: AgentCanvasChangeMessage | null = null
    /** 运行中插进对话的系统行：别人的改动通知、技能加载（按发生的先后，排在 assistant 消息之后） */
    const liveChanges: (AgentCanvasChangeMessage | AgentSkillLoadedMessage)[] = []
    let outcome: RunOutcome
    let nextLlm = llmHistory

    /** 这一轮在网关上的登记；叫停 / 收尾时 close()，令牌即刻作废 */
    let gatewayRun: GatewayRun | null = null
    let handle: SandboxHandle | null = null
    let sandboxExit: SandboxExit | null = null
    /** 叫停 / 结束时 abort：网关在途的上游模型请求、服务端的工具执行都看它 */
    const runAbort = new AbortController()
    /** runner 报来的收尾；没报（被杀 / 崩溃）为 null */
    let runnerFinish: FinishRequest | null = null
    /** 网关拒了 runner 的 bootstrap 兑换，因为协议版本对不上（镜像没重建）；没发生为 null */
    let protocolMismatch: { runnerVersion: number | null; serverVersion: number } | null = null
    let exitGrace: ReturnType<typeof setTimeout> | undefined
    /** runner 上报的 message_end：pi 这一轮追加进上下文的全部消息，按顺序（重建模型上下文） */
    const appended: AgentMessage[] = []
    /** 网关代执行过、还没等到 runner 报结束的画布工具调用：toolCallId → 执行记录 */
    const executed = new Map<string, ExecutedCall>()
    /** 工具调用日志要的参数摘要和耗时：end 事件不带参数，start 时记下来（媒体工具用） */
    const startedCalls = new Map<string, { args: unknown; at: number }>()
    let turns = 0
    let gatewayToolCalls = 0

    const record = (entry: Omit<Parameters<AgentRunLog['recordToolCall']>[0], 'runId' | 'grantId'>) => {
      const grantId = authority?.grantId ?? null
      toolLogs.push(sideWrite('工具调用日志', () => runLog.recordToolCall({ runId: run.runId, grantId, ...entry })))
    }
    const recordExecuted = (toolCallId: string, call: ExecutedCall) =>
      record({
        toolCallId,
        name: call.name,
        ok: call.ok,
        args: call.args,
        elementIds: call.elementIds,
        error: call.error,
        durationMs: call.durationMs,
        createdAt: call.at,
      })

    const timer = setTimeout(() => stopRun(run, `超过 ${limits.timeoutMs / 1000} 秒，已停止`), limits.timeoutMs)

    // —— 3. 跑：签 Grant → 开画布 → 网关登记 → 驱动起沙箱，runner 在里面跑 pi ——
    try {
      // 签发 Grant：发起人此刻就没权限（画布刚被删 / 刚被移出项目）→ 抛，这一轮以 RUN_ERROR 收尾
      const issued = await options.authorities.issue({
        runId: run.runId,
        flowId,
        userId,
        conversationId,
        capabilities: requestedCapabilities(Boolean(options.mediaTool)),
        model: resolved.label,
        timeoutMs: limits.timeoutMs,
        stop: (kind, reason) => stopRun(run, reason, kind === 'expired' ? 'expired' : 'cancelled'),
      })
      const gate: RunAuthority = {
        grantId: issued.grantId,
        scopes: issued.scopes,
        async authorize(capability) {
          try {
            await issued.authorize(capability)
          } catch (err) {
            // Grant 失效（失权 / 撤销 / 到期）：整轮停，不只是拒掉这一次（docs/22 §5 stop）
            if (stopsRun(err)) stopRun(run, err.message, err.kind === 'expired' ? 'expired' : 'cancelled')
            throw err
          }
        },
        release: (end) => issued.release(end),
      }
      authority = gate
      runStart.grantId = gate.grantId
      const startRecord = { ...runStart }
      runStarted = sideWrite('运行日志', () => runLog.startRun(startRecord))

      canvas = await input.openCanvas(run.runId, gate)
      const opened = canvas

      // —— 这一轮的技能（docs/23 §3.2）：提供哪些、一开始就加载哪些 ——
      const mentionedNodeTypes = await opened.read((doc) =>
        parseNodeMentions(text).flatMap((id) => {
          const node = readNodeById(doc, id)
          return node ? [node.type] : []
        }),
      )
      const env: SkillAvailability = {
        scopes: gate.scopes,
        deployment: {
          imageInput: resolved.model.input.includes('image'),
          mediaReader: Boolean(options.mediaReader),
          sandboxExec: Boolean(options.mediaTool),
        },
      }
      const plan = registry.plan({ env, previous: previousSkills, mentionedNodeTypes })
      /** 一轮共享的预算：删除、图片字节 —— 所有技能的工具拿同一份 */
      const runState: ToolRunState = { deleted: 0, mediaBytes: 0 }
      const skillContext: SkillContext = {
        side: 'server',
        canvas: opened,
        runState,
        ...(options.mediaReader ? { media: options.mediaReader } : {}),
        sandbox: NO_SANDBOX,
      }
      const files: Record<string, string> = {}
      for (const skill of plan.offered) {
        offeredSkills.set(skill.id, skill)
        // 每个工具在网关上执行之前判它声明的能力（失权时整轮停）；runner 工具只留定义（不经网关、不判权，docs/22 §3）
        for (const tool of skill.tools(skillContext)) {
          tools.set(tool.name, tool.execution === 'runner' ? tool : authorizedTool(tool, gate))
        }
        // 初始化钩子：写进 runner 工作目录的文件（media-exec 的 canvas.json）
        if (skill.workdirFiles) Object.assign(files, await skill.workdirFiles({ canvas: opened }))
      }
      for (const skill of plan.loaded) loadedSkills.add(skill.id)
      // 常驻观察：基线与挂上观察在同一个同步段里（中间插不进别人的事务），顺手算跨轮差异
      const activeWatch = createCanvasWatch({
        canvas: opened,
        windowMs: limits.changeWindowMs,
        nameOf: (actor) => actorName(actor, run.runId),
        onNotice: (notice) => queuedNotices.push(notice),
      })
      watch = activeWatch
      const sinceNotice = await opened.read((doc) => {
        const baseline = activeWatch.attach(doc)
        return previousDigest ? diffDigests(previousDigest, baseline, doc) : null
      })
      const since = sinceNotice ? renderNotice(sinceNotice, noticeLimits) : null
      if (since) {
        sinceLastRun = canvasChangeMessage(since)
        send(mapper.canvasChange(sinceLastRun))
      }

      const expanded = await opened.read((doc) => expandMentions(text, (id) => lookupMention(doc, id)))
      const prompt = since ? `${since.modelText}\n\n用户这一轮的消息：\n${expanded}` : expanded

      /**
       * `load_skill`（docs/23 §3.3）：判提供集合、是否已加载、本轮次数；通过就记进已加载、发「已加载：…」那一行，
       * 结果带上这个技能的提示段与工具名单，并 `terminate` 这一批（runner 并入新工具后 continue）
       */
      const loadSkill = async (id: string) => {
        const skill = offeredSkills.get(id)
        if (!skill) {
          throw new Error(
            registry.get(id)
              ? `技能 ${id} 这一轮不提供（授权或部署条件不满足），不能加载；用已有的工具完成，或向用户说明`
              : `没有技能 ${id}；能加载的技能见系统提示里的技能目录`,
          )
        }
        const toolNames = skill.tools(skillContext).map((tool) => tool.name)
        if (loadedSkills.has(id)) {
          return {
            content: [{ type: 'text' as const, text: `技能「${skill.title}」已经加载了，这些工具现在就能用：${toolNames.join('、')}` }],
            details: { summary: `技能「${skill.title}」已加载`, elementIds: [] },
          }
        }
        if (skillLoads >= limits.maxSkillLoads) {
          throw new Error(`本轮已经加载了 ${skillLoads} 次技能，达到上限 ${limits.maxSkillLoads}，不能再加载；请用已有的工具完成，或向用户说明`)
        }
        skillLoads += 1
        loadedSkills.add(id)
        const display: AgentSkillLoadedMessage = {
          id: createId('skl'),
          role: 'skill-loaded',
          skill: { id, title: skill.title },
          createdAt: Date.now(),
        }
        liveChanges.push(display)
        send(mapper.skillLoaded(display))
        return {
          content: [{ type: 'text' as const, text: loadedSkillText(skill, toolNames) }],
          details: { summary: `加载技能「${skill.title}」`, elementIds: [], loadedSkill: id },
          terminate: true,
        }
      }
      tools.set(LOAD_SKILL_TOOL_NAME, authorizedTool(createLoadSkillTool(loadSkill), gate))

      const runnerInput: RunnerInput = {
        runId: run.runId,
        systemPrompt: systemPromptFor({
          loaded: plan.loaded,
          catalog: plan.catalog,
          unavailable: plan.unavailable.map((id) => ({ id, title: registry.titleOf(id) })),
          maxSkillLoads: limits.maxSkillLoads,
        }),
        prompt,
        llmMessages: llmHistory,
        skills: { loaded: plan.loaded.map((skill) => skill.id), offered: plan.offered.map((skill) => skill.id) },
        model: runnerModelOf(resolved.model),
        limits: { maxToolCalls: limits.maxToolCalls },
        files,
      }

      /** runner 的一次画布工具调用：网关在这里判权、校验参数、执行（一次调用一个 Y 事务） */
      const executeTool = async (request: ToolCallRequest): Promise<ToolCallResponse> => {
        const tool = tools.get(request.name)
        // 不是这一轮提供的工具，或在 runner 里执行的：网关不代它执行
        if (!tool || tool.execution === 'runner') return { isError: true, message: `Tool ${request.name} not found` }
        // 本轮没加载的技能里的工具（runner 不可信，可能直接点名）：拒绝。和能力判权是两道独立的检查（docs/23 §3.3）
        const owner = registry.skillOfTool(tool.name)
        if (owner && !loadedSkills.has(owner.id)) {
          return {
            isError: true,
            message: `工具 ${tool.name} 未加载：它属于技能「${owner.title}」（${owner.id}），先单独调用 load_skill({ id: '${owner.id}' })`,
          }
        }
        gatewayToolCalls += 1
        if (gatewayToolCalls > limits.maxToolCalls) {
          return { isError: true, message: `本轮工具调用已达上限 ${limits.maxToolCalls} 次，请停止并向用户说明进度` }
        }
        let args: unknown
        try {
          // runner 那边 pi 校验过一次，但它在不可信区：这里按同一份 schema 再校验，工具只吃校验过的参数
          args = validateToolArguments(tool, {
            type: 'toolCall',
            id: request.toolCallId,
            name: request.name,
            arguments: (request.args ?? {}) as Record<string, unknown>,
          })
        } catch (err) {
          return { isError: true, message: errorText(err) }
        }
        const at = Date.now()
        try {
          const result = await tool.execute(request.toolCallId, args as never, runAbort.signal)
          const details = result.details
          const elementIds = Array.isArray(details?.elementIds)
            ? details.elementIds.filter((id): id is string => typeof id === 'string')
            : []
          executed.set(request.toolCallId, {
            name: tool.name,
            args: digestArgs(args),
            ok: true,
            elementIds,
            error: null,
            durationMs: Date.now() - at,
            at: Date.now(),
          })
          return { isError: false, content: result.content, details, ...(result.terminate ? { terminate: true } : {}) }
        } catch (err) {
          const message = errorText(err)
          executed.set(request.toolCallId, {
            name: tool.name,
            args: digestArgs(args),
            ok: false,
            elementIds: [],
            error: message.slice(0, TOOL_ERROR_LOG_LIMIT),
            durationMs: Date.now() - at,
            at: Date.now(),
          })
          return { isError: true, message }
        }
      }

      /**
       * 一批调过工具的 turn_end（runner 来取，pi 接着就取 steer 队列、再请求模型）：把窗口里攒着的先合并，
       * 排着的通知并成**一条**交出去。叫停中的不交 —— 没有下一次请求了。
       */
      const takeChanges = async (): Promise<CanvasChangesResponse> => {
        await activeWatch.flush()
        if (run.stopped !== null || queuedNotices.length === 0) return { change: null }
        const merged = mergeNotices(queuedNotices.splice(0))
        const rendered = merged ? renderNotice(merged, noticeLimits) : null
        if (!merged || !rendered) return { change: null }
        const id = createId('chg')
        steered.set(id, { notice: merged, display: canvasChangeMessage(rendered) })
        return { change: { id, text: rendered.modelText } }
      }
      /** pi 把 steer 的那条放进上下文了：这时才发通知、记进对话（模型确实看到了） */
      const deliverSteered = (id: string) => {
        const entry = steered.get(id)
        if (!entry) return
        steered.delete(id)
        liveChanges.push(entry.display)
        send(mapper.canvasChange(entry.display))
      }

      /** 工具结束时写一行工具调用日志：画布工具以网关的执行记录为准，媒体工具按 runner 报的 */
      const logToolCall = (event: Extract<RunnerEvent, { type: 'tool_execution_end' }>) => {
        const begun = startedCalls.get(event.toolCallId)
        startedCalls.delete(event.toolCallId)
        const done = executed.get(event.toolCallId)
        if (done) {
          executed.delete(event.toolCallId)
          recordExecuted(event.toolCallId, done)
          return
        }
        const local = tools.get(event.toolName)?.execution === 'runner'
        // 没经网关的画布工具（被 runner 拦下、参数不对、工具不存在）什么都没做；它报「成功」也不算数
        const ok = local && !event.isError
        const details = (event.result.details ?? null) as { elementIds?: unknown } | null
        const elementIds =
          local && Array.isArray(details?.elementIds)
            ? details.elementIds.filter((id): id is string => typeof id === 'string')
            : []
        // 错误原因取 mapper 刚算出来的那份（就是回给模型的文本），截短；它是工具自己的报错，不是用户正文
        const view = mapper.message.toolCalls.find((call) => call.id === event.toolCallId)
        const now = Date.now()
        record({
          toolCallId: event.toolCallId,
          name: event.toolName,
          ok,
          args: digestArgs(begun?.args),
          elementIds,
          error: ok ? null : (event.isError ? (view?.error ?? '工具调用失败') : '没有经网关执行').slice(0, TOOL_ERROR_LOG_LIMIT),
          durationMs: begun ? now - begun.at : 0,
          createdAt: now,
        })
      }

      /** runner 上报的一批事件：按顺序映射、发出去（批内同步，网关保证批与批不并发） */
      const onEvents = (events: RunnerEvent[]) => {
        for (const event of events) {
          // 叫停之后（比如这一批里的 turn_end 刚撞上步数上限）的事件不再收
          if (run.stopped !== null) return
          if (event.type === 'tool_execution_start') {
            startedCalls.set(event.toolCallId, { args: event.args, at: Date.now() })
          }
          if (event.type === 'turn_end') {
            turns += 1
            if (turns >= limits.maxTurns) stopRun(run, `超过本轮步数上限 ${limits.maxTurns}，已停止`)
          }
          if (event.type === 'message_end') appended.push(event.message)
          const mapped = mapper.handle(event)
          if (event.type === 'tool_execution_end') logToolCall(event)
          send(mapped)
          if (event.type === 'message_end' && event.steerId) deliverSteered(event.steerId)
        }
      }

      const registration = gateway.open({
        runId: run.runId,
        userId,
        grantId: gate.grantId,
        scope: scopeText(gate.scopes, flowId),
        signal: runAbort.signal,
        handlers: {
          input: async () => runnerInput,
          tool: executeTool,
          changes: takeChanges,
          events: onEvents,
          finish(request) {
            runnerFinish ??= request
            // 收尾了：令牌就此作废；给它一点时间自己退出，过了就杀
            registration.close()
            exitGrace ??= setTimeout(() => void handle?.kill('runner 收尾后没有按时退出'), RUNNER_EXIT_GRACE_MS)
          },
          protocolMismatch(info) {
            protocolMismatch ??= info
            console.warn(
              `[agent] run=${run.runId} 沙箱 runner 的协议版本（${info.runnerVersion ?? '未声明'}）和服务端（${info.serverVersion}）不一致，已拒绝；沙箱镜像需要重建（pnpm build:sandbox-image）`,
            )
          },
          authorizeLlm: () => gate.authorize('llm:invoke'),
          async authorizeRenewal() {
            if (run.stopped !== null) throw new RunAuthorityError('revoked', run.stopped.reason)
            // 续期不是一项能力；拿这一轮的基础能力 flow:read 探一下 Grant 还活着（失效即整轮停）
            await gate.authorize('flow:read')
          },
        },
      })
      gatewayRun = registration

      // 叫停 = 先作废令牌（之后的请求一律 401、在途的上游模型请求掐断），再立即杀沙箱
      run.interrupt = () => {
        registration.close()
        runAbort.abort()
        if (handle) void handle.kill(run.stopped?.reason ?? '已中止')
      }
      /*
       * 挂上 interrupt 之前就已经要求停下了（签发 / 开画布那几十毫秒里点了停止、超时、失权、进程退出）：
       * 不起沙箱、不调模型。
       */
      if (run.stopped === null) {
        handle = await options.driver.start({
          runId: run.runId,
          flowId,
          ownerId: userId,
          grantId: gate.grantId,
          image: options.sandbox?.image ?? '',
          resources: sandboxResources,
          gatewayUrl: options.gateway.url,
          credential: { kind: 'bootstrap', token: registration.bootstrapToken },
        })
        // 起沙箱那几十毫秒里被叫停了：起来了也立刻杀（await 期间可能变了，TS 的收窄看不见）
        const late = run.stopped as RunState['stopped']
        if (late !== null) void handle.kill(late.reason)
        sandboxExit = await handle.wait()
      }

      const stopped = run.stopped
      const received = completeToolResults(appended)
      nextLlm = trimLlmHistory([...llmHistory, ...received], limits.llmMessages)
      // 两者都在回调里赋值，TS 的收窄看不见：显式放宽
      const finishReport = runnerFinish as FinishRequest | null
      const exitInfo = sandboxExit as SandboxExit | null
      const mismatch = protocolMismatch as { runnerVersion: number | null; serverVersion: number } | null
      const last = received.at(-1)
      outcome = stopped
        ? stoppedOutcome(stopped)
        : mismatch
          ? { type: 'error', message: protocolMismatchMessage(mismatch), code: 'runner_protocol_mismatch' }
          : !finishReport
            ? { type: 'error', message: runnerFailure(exitInfo), code: 'runner_failed' }
            : finishReport.error !== null
              ? { type: 'error', message: `agent 运行出错：${finishReport.error}`, code: 'run_failed' }
              : last?.role === 'assistant' && last.stopReason === 'aborted'
                ? { type: 'cancelled', reason: '已中止' }
                : mapper.modelError
                  ? { type: 'error', message: mapper.modelError, code: 'model_error' }
                  : { type: 'success' }
    } catch (err) {
      // 签发失败（发起时就已失权）、打开画布失败（画布已删 / 配额锁定）、沙箱起不来……这一轮直接失败
      outcome = run.stopped
        ? stoppedOutcome(run.stopped)
        : { type: 'error', message: errorText(err), code: 'run_failed' }
      if (handle && !sandboxExit) await handle.kill('这一轮出错，收尾')
    } finally {
      clearTimeout(timer)
      clearTimeout(exitGrace)
      // 无论怎么结束：令牌作废、在途请求掐断
      gatewayRun?.close()
      runAbort.abort()
    }
    // 网关执行了、但 runner 没来得及报结束的工具调用（被杀在半路）：照样记进审计
    for (const [toolCallId, call] of executed) recordExecuted(toolCallId, call)
    executed.clear()
    // 出错的路径也要停掉观察（正常路径在下面存摘要之前停）
    if (!canvas) watch?.stop()

    // —— 跨轮摘要：窗口里还攒着的先合并；没交给模型的那些退回改动之前，下一轮再报 ——
    let closingCanvasDigest: CanvasDigest | null | undefined
    if (watch && canvas) {
      await watch.flush()
      watch.stop()
      const undelivered = [...[...steered.values()].map((entry) => entry.notice), ...queuedNotices]
      const opened = canvas
      try {
        closingCanvasDigest = await opened.read((doc) => closingDigest(doc, undelivered))
      } catch (err) {
        // 失权 / 连接没了：不更新摘要（留着上一份），下一轮的差异从上一份算起
        console.warn(`[agent] run=${run.runId} 画布摘要没能更新`, err)
      }
    }

    // —— 4. 一次 save 落定这一轮 ——
    const finishing = mapper.finish(outcome)
    const finalChat = trimChat(
      [...chat, ...(sinceLastRun ? [sinceLastRun] : []), mapper.message, ...liveChanges],
      limits.chatMessages,
    )
    let persistError: string | null = null
    try {
      const saved = await store.save(flowId, userId, conversationId, {
        messages: finalChat,
        summary: conversationSummary(finalChat),
        llmMessages: nextLlm,
        // 只增不减：之前的 ∪ 这一轮加载的（这一轮不提供的旧技能照样留着，下一轮可能又提供了）
        skills: [...new Set([...previousSkills, ...loadedSkills])],
        ...(closingCanvasDigest !== undefined ? { canvasDigest: closingCanvasDigest } : {}),
      })
      if (!saved) persistError = '会话已被删除'
    } catch (err) {
      persistError = errorText(err)
    }
    if (persistError !== null) {
      console.error(`[agent] run=${run.runId} flow=${flowId} conversation=${conversationId} 对话没能保存：${persistError}`)
      // 换掉最后一帧（RUN_FINISHED / RUN_ERROR），前面关文字段的那几帧照发
      const terminal = finishing.pop()
      const earlier = terminal?.type === AgentEventType.RUN_ERROR ? `${terminal.message}；另外，` : ''
      finishing.push({
        type: AgentEventType.RUN_ERROR,
        message: `${earlier}这一轮的对话没能保存（${persistError}），刷新后会丢失；画布上已做的改动不受影响`,
        code: 'persist_failed',
        timestamp: Date.now(),
      })
    }

    // —— 5. 收尾 ——
    send(finishing)

    const closing: Promise<unknown>[] = []
    if (canvas) closing.push(canvas.close())
    const closed = await Promise.allSettled(closing)
    for (const item of closed) {
      if (item.status === 'rejected') console.warn(`[agent] run=${run.runId} 收尾失败`, item.reason)
    }

    const finish: AgentRunFinish = {
      ...runStart,
      status: persistError !== null ? 'error' : outcome.type,
      error:
        persistError !== null
          ? `对话没能保存：${persistError}`
          : outcome.type === 'error'
            ? outcome.message
            : outcome.type === 'cancelled'
              ? (outcome.reason ?? '已中止')
              : outcome.type === 'expired'
                ? outcome.reason
                : null,
      toolCallCount: mapper.message.toolCalls.length,
      finishedAt: Date.now(),
    }
    // 关掉 Grant：这一轮结束了，它不能再被用来做任何事（已因失权撤销的，宿主保留那个原因）
    const ended = authority
    if (ended) await sideWrite('授权收尾', () => ended.release({ status: finish.status, reason: finish.error }))
    await Promise.all([runStarted, ...toolLogs])
    await sideWrite('运行日志', () => runLog.finishRun(finish))

    console.info(
      `[agent] run=${run.runId} flow=${flowId} 结束（${finish.status}，${finish.toolCallCount} 次工具调用，` +
        `${finish.finishedAt - startedAt}ms）`,
    )
  }

  return {
    enabled: resolved !== null,
    modelLabel: resolved?.label ?? null,
    disabledReason: resolved ? null : disabledReason,
    gateway: { handle: (request) => gateway.handle(request) },

    async view(flowId, userId) {
      // 先同步取一份快照：下面的 await 期间列表可能变化，但这次回复要自洽
      const entries = withMine(activeRuns(flowId), userId)
      // 我有任务在跑：面板默认打开最近发起的那一轮所在的会话（它也可能刚被删掉 —— 退回最近的那个）
      const own = entries.filter((entry) => entry.mine).at(-1) ?? null

      const running = own ? await store.get(flowId, own.conversationId) : null
      const latest = running && running.userId === userId ? running : await store.latest(flowId, userId)

      return {
        enabled: resolved !== null,
        running: entries.length > 0,
        activeRuns: entries,
        latest: latest ? await viewOf(latest, userId) : null,
      }
    },

    activeRuns,

    async listConversations(flowId, userId) {
      const rows = await store.list(flowId)
      const owners = await profiles(rows.map((row) => row.userId))
      return rows.map((row) => summaryOf(row, userId, owners))
    },

    async getConversation(flowId, userId, id) {
      const row = await store.get(flowId, id)
      return row ? viewOf(row, userId) : null
    },

    async deleteConversation(flowId, userId, id) {
      const row = await store.get(flowId, id)
      if (!row) return 'not-found'
      if (row.userId !== userId) return 'forbidden'
      // 正在跑的那个会话不能删：结尾那次 save 会扑空，这一轮的对话就凭空没了
      if (isConversationRunning(flowId, id)) return 'running'
      return (await store.remove(flowId, userId, id)) ? 'deleted' : 'not-found'
    },

    isRunning: (flowId) => [...runs.values()].some((run) => run.flowId === flowId),

    start(input) {
      if (!resolved) {
        return { ok: false, reason: 'disabled', message: disabledReason }
      }
      // 同步占位：从这里到 claimConversation 之间没有 await，同一个会话的第二个发起者不可能插进来
      if (input.conversationId !== null && isConversationRunning(input.flowId, input.conversationId)) {
        return { ok: false, reason: 'busy', message: '这个会话已经有一轮 agent 正在运行，请等它结束或先停止它' }
      }

      // 发起者是第一个订阅者，在第一帧之前挂上（execute 的同步段就可能发出那一帧 RUN_ERROR）
      const initiator = subscriberOf(input.emit)
      const run: RunState = {
        runId: createId('run'),
        flowId: input.flowId,
        userId: input.userId,
        startedAt: Date.now(),
        conversationId: input.conversationId,
        conversationTitle: '',
        nodeId: null,
        owner: null,
        listed: false,
        stopped: null,
        // 网关登记之前，叫停只是记在 `stopped` 上；登记后 execute 把它换成「作废令牌 + 杀沙箱」
        interrupt: () => {},
        done: Promise.resolve(),
        replay: [],
        replayChars: 0,
        finished: false,
        subscribers: new Set([initiator.subscriber]),
      }
      runs.set(run.runId, run)
      if (input.conversationId !== null) claimConversation(run, input.conversationId)

      run.done = execute(input, run)
        .catch((err: unknown) => console.error(`[agent] run=${run.runId} 异常`, err))
        .finally(() => {
          // 没走到最后一帧就异常退出了：补一帧收尾，订阅者才知道这一轮完了
          if (!run.finished) {
            publish(run, {
              type: AgentEventType.RUN_ERROR,
              message: '这一轮异常结束',
              code: 'run_failed',
              timestamp: Date.now(),
            })
          }
          // 删掉条目 = 释放补发缓冲与会话槽位；之后再来接回的一律 not-found
          runs.delete(run.runId)
          releaseConversation(run)
          if (run.listed) notifyRunsChange(run.flowId)
        })

      return {
        ok: true,
        runId: run.runId,
        done: run.done,
        unsubscribe: () => {
          if (run.subscribers.delete(initiator.subscriber)) initiator.subscriber.complete()
        },
      }
    },

    subscribe(flowId, runId, onEvent) {
      const run = runs.get(runId)
      if (!run || run.flowId !== flowId) return { ok: false, reason: 'not-found' }
      if (!run.replay) return { ok: false, reason: 'overflowed' }

      const { subscriber, done } = subscriberOf(onEvent)
      // 补发与挂上之间没有 await：这期间不可能有新帧插进来，所以不漏也不重
      for (const event of run.replay) deliver(subscriber, event)
      if (run.finished) {
        // 最后一帧已经发过了（这一轮正在关画布、写日志）：补发里就有它，到此为止
        subscriber.complete()
        return { ok: true, done, unsubscribe: () => {} }
      }
      run.subscribers.add(subscriber)
      return {
        ok: true,
        done,
        unsubscribe: () => {
          if (run.subscribers.delete(subscriber)) subscriber.complete()
        },
      }
    },

    abort(flowId, runId, actor) {
      const run = runs.get(runId)
      if (!run || run.flowId !== flowId) return 'not-running'
      if (run.userId !== actor.userId && !actor.admin) return 'forbidden'
      stopRun(run, run.userId === actor.userId ? '已中止' : '已被项目管理员中止')
      return 'aborted'
    },

    async abortAll(reason) {
      const pending = [...runs.values()]
      for (const run of pending) stopRun(run, reason)
      await Promise.allSettled(pending.map((run) => run.done))
    },

    liveRunIds() {
      return new Set(runs.keys())
    },
  }
}
