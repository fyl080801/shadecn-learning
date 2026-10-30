import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  isContextOverflow,
  validateToolArguments,
  type Api,
  type AssistantMessage,
  type JsonObject,
  type Message,
  type Model,
  type ToolCall,
  type ToolResultMessage,
} from '@earendil-works/pi-ai'
import { estimateMessageTokens, estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import {
  AGENT_DELEGATE_TOOL_NAME,
  AGENT_PROMPT_MAX_LENGTH,
  AGENT_SUMMARY_MAX_LENGTH,
  AGENT_TITLE_MAX_LENGTH,
  AgentEventType,
  canonicalSkillIds,
  NODE_MENTION_PATTERN,
  parseAgentAttachmentRefs,
  parseNodeMentions,
  withMine,
  type AgentAttachment,
  type AgentAttachmentRef,
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
import { nodesMap } from '@shadecn/shared/flow-doc'
import { createdNodeIds, dataWriteTargets, leaseAgentOf, type NodeLease, type NodeLeaseRegistry } from './occupancy.ts'
import type { ConversationSlot, ReplayEntry, ReplayRecord, RunRecord, RunRegistry, StopCommand } from './run-registry.ts'
import { createAgentGateway, isProxiedModelApi, PROXIED_MODEL_APIS, type GatewayRun } from './gateway.ts'
import type { MediaReader } from './media.ts'
import type { ResolvedAgentModel } from './model.ts'
import {
  attachmentsPrompt,
  expandMentions,
  loadedSkillText,
  lookupMention,
  subagentBrief,
  SUBAGENT_PROMPT,
  systemPromptFor,
} from './prompt.ts'
import { MAIN_AGENT_ID } from './protocol.ts'
import type {
  CanvasChangesResponse,
  DelegateRequest,
  DelegateResponse,
  FinishRequest,
  RunnerEvent,
  RunnerInput,
  RunnerModel,
  SubagentFinishRequest,
  SubagentFinishResponse,
  ToolCallRequest,
  ToolCallResponse,
} from './protocol.ts'
import type { SandboxDriver, SandboxExit, SandboxHandle, SandboxResources } from './sandbox/driver.ts'
import {
  BUILTIN_SKILLS,
  createLoadSkillTool,
  DELEGATE_SKILL_ID,
  LOAD_SKILL_TOOL_NAME,
  NO_SANDBOX,
  REQUEST_CONFIRMATION_TOOL_NAME,
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
import { readNodeById, VIEW_ATTACHMENT_TOOL_NAME, type CanvasTool, type ToolRunState } from './tools.ts'

/**
 * 编排：会话、「一个会话同时只跑一轮」、把一轮 pi Agent 跑完。
 *
 * ## 什么持久化、什么在内存
 *
 * - **会话**（对话记录 + 模型上下文）经注入的 {@link AgentConversationStore} 落库，按「画布 + 发起人」归属，
 *   一个人在一张画布上可以有多个会话；项目画布上别人的会话只读可见（读的口径见 store.ts「归属」）。
 *   进程重启、换到另一个副本，会话都还在。
 * - **运行日志**（每轮一行 + 每次工具调用一行）经注入的 {@link AgentRunLog} 落库，审计用途。
 * - **「谁在跑」分两层**（docs/20 §3.10.10，F14）：本进程的 `runs` / `busyConversations`（`RunState` 本体、同一 tick 的占位），
 *   和注入的 {@link RunRegistry}（宿主：共享层，多副本是 redis）里的**任务登记**、**会话槽位**、**补发日志**、**停止指令**。
 *   任务列表、「这个会话在不在跑」、接回、停止都以共享层为准，所以落在哪个副本上都一样；
 *   工具执行、画布连接、模型代理仍只在持有副本上（runner 只连回发起它的副本）。进程崩溃时这一轮没了，
 *   它的登记 / 槽位 / 日志不再续期，一个 TTL 内过期。
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
 * **列表是共享登记的全量**（docs/20 §3.10.10）：每次推送先把本副本在这张画布上的轮次写进登记（`syncRecord`），再按画布前缀读出
 * 全部（含别的副本上的），所以哪个副本发的广播都是完整的；推送按画布串成一条链，后发的不会比先发的旧。
 * 登记的值 = 列表那一项 + `instanceId`，由持有副本覆盖写（心跳续 TTL，不等节流），收尾时比较后删。
 * 准备会话就失败的那种（只发一帧 RUN_ERROR）从没进过列表，也就不会「出现又消失」。
 * 列表里每一项带 `occupies`（这一轮占用的节点）和 `expiresAt`（最近一次续期 + TTL）：占用变化、每次续期（1/3 TTL）
 * 也重推全量列表，**每张画布每 `runsThrottleMs` 至多一次**（{@link scheduleRunsChange}）；进 / 离列表不节流。
 *
 * ## 节点占用与写入检查（docs/20 §3.10.8）
 *
 * 登记表是注入的 {@link NodeLeaseRegistry}（宿主：共享层），**只在这里写**：网关执行工具时，在能力判权**之后**、
 * 工具执行之前，另有一道独立的检查（`guardDataWrites`，不和判权合并、不进工具实现）——
 * 算出这次会写哪些节点的 `data`（`occupancy.ts` 的 `dataWriteTargets`），先查「改过」（本轮打开画布以来别人改过 data、
 * 还没重读的，靠常驻观察的 `onDataTouched` 同步登记），再逐个 `claim`（已是自己的直接过，有一个被别人占着就退掉这次刚占的、
 * 拒绝这次调用）。拒绝都是给模型看的工具错误，不停整轮。新建节点执行后占用；调用没执行成就退掉这次刚占的。
 * 持有者每 1/3 TTL 续期（比较后写，已易主的拿掉）；这一轮结束（任何结局，含 `abortAll`）释放全部（比较后删）。
 * 读类工具（`details.readNodeIds`）读过的移出「改过」，结果末尾标出别的 run 占着的节点；`readNodeIds` 不交给 runner。
 *
 * ## 子 agent（docs/20 §3.10.11）
 *
 * 子 agent 不是新的一轮：runner 在同一个进程里再建一个 pi `Agent`，令牌、会话、Grant、沙箱、任务列表项都是这一轮的。
 * 这里每个 agent 一个 {@link RunAgent}（父 agent 一开始就在；子 agent 由 `/agent/delegate` 登记、`/agent/finish` 收掉）：
 * 步数、已加载的技能、「改过」集合、占用（`NodeLease.agentId`）按 agent 各算；工具调用次数、删除预算、图片字节全轮共用。
 * 只有父 agent 能派（只有一层）；同时 / 累计上限在这里判；子 agent 的事件只改父会话里的子任务条目，不进父 agent 的上下文。
 * 单轮时长在「有子 agent 在跑」（这里自己的登记）时暂停，总时长上限是墙钟、不暂停；沙箱硬期限与 Grant 按总时长上限算。
 *
 * **空闲上限**（`idleTimeoutMs`）：runner 来过网关之后，网关上既没有在途请求（模型请求算到响应流读完）、
 * 又连续这么久没有新请求 → 叫停（cancelled，原因写明空闲）。
 *
 * ## 一轮的生命周期与失败语义
 *
 * `start()` 先在本进程里**同步**占住这个会话的槽位（同一会话的第二个发起者立刻得到 `busy`，中间没有 await 可插队），
 * 再到共享登记 `claimSlot`（原子的「不存在才写」：同一个会话在两个副本上同时发起只有一个占得到，另一个 `busy`；
 * 共享登记不可用 → `unavailable`）。新会话没有可撞的槽位，总能开始（建好会话后同样占上共享槽位）。然后异步跑：
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
 * - 改动按 `changeWindowMs` 合并成一条通知，排队；**只在一批调过工具之后、下一次请求模型之前**
 *   由 runner 来取（`/canvas/changes`：先把窗口里攒着的冲掉，排着的并成一条），runner 在 pi 的 `prepareNextTurnWithContext` 里交给 pi ——
 *   模型正在写最终回复时到的改动不交出去（pi 那时不调这个钩子），留给跨轮差异；这条时机规则由 runner 执行；
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
 *
 * **共享补发日志（多副本，docs/20 §3.10.10）**：同一批帧另外**按批**追加进 {@link RunRegistry} 的补发日志 ——
 * 一次 `send`（runner 上报的一批事件映射之后的全部帧、一次收尾……）= 一条记录，带从 1 起连续的 `seq`，文字增量不逐帧写。
 * 追加按顺序串成一条链（{@link RunState.replayLog}），收尾时先等它写完再删登记。本进程的订阅者走上面的内存快路径；
 * 别的副本收到接回请求时（这一轮不在它的 `runs` 里）：先查任务登记（没有 = 404），再从头读日志补发（断号或带溢出标记 = 410），
 * 然后阻塞读后续的；一段时间没有新帧就查一次登记，登记没了（持有副本崩溃，收尾帧不会来了）就关流。
 * 两条路在同一批上判溢出（内存缓冲溢出的那一批起，日志记录都带 `overflow`，并只留最近 {@link REPLAY_TAIL_RECORDS} 条给
 * 还挂着的跨副本订阅者），所以接回得到的结果（补发 / 410 / 404）和落在哪个副本无关。日志每次追加、每次心跳续一个 TTL，
 * 这一轮结束后不再续，一个 TTL 后自然删掉。
 */

export interface RunLimits {
  /** 一轮里最多几次「模型回复」（每次调工具之后模型都要再回一次） */
  maxTurns: number
  /** 一轮里最多几次工具调用，超出的被拦下并告诉模型 */
  maxToolCalls: number
  /**
   * 一轮的单轮时长上限：父 agent 在 `delegate_task` 里等、并且确实有子 agent 在跑的那段时间**不计入**（暂停计时，
   * 依据服务端自己的派发 / 结束登记，docs/20 §3.10.11）
   */
  timeoutMs: number
  /**
   * 总时长上限（`AGENT_RUN_TOTAL_TIMEOUT_MS`）：一轮从开始算的墙钟时间，含它的全部子 agent，不暂停。
   * 沙箱硬期限（驱动的 `deadlineMs`）和 Grant 的绝对过期时间按它算 —— 一轮开始时不知道它会不会派子 agent
   */
  totalTimeoutMs: number
  /** 同时在跑的子 agent 最多几个（服务端判，docs/20 §3.10.11） */
  maxSubagents: number
  /** 一轮累计最多派几个子 agent */
  maxSubagentsPerRun: number
  /** 交回父 agent 的子 agent 最终回复最多多少字 */
  subagentReplyChars: number
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
  /**
   * 空闲上限（docs/20 §3.10.8「沙箱中断」，`AGENT_RUN_IDLE_TIMEOUT_MS`）：网关上这一轮既没有在途请求、
   * 也连续这么久没有新请求 → 按超时停下。模型请求算到响应流结束，长时间流式输出不算空闲
   */
  idleTimeoutMs: number
  /** 任务列表因占用变化 / 续期而重发的节流（毫秒，docs/20 §3.4「每秒至多一次」）；进 / 离列表不节流 */
  runsThrottleMs: number
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxTurns: 24,
  maxToolCalls: 60,
  timeoutMs: 5 * 60_000,
  totalTimeoutMs: 30 * 60_000,
  maxSubagents: 3,
  maxSubagentsPerRun: 10,
  subagentReplyChars: 2000,
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
  idleTimeoutMs: 120_000,
  runsThrottleMs: 1000,
}

/** 会话 id 的长度上限 —— 只是挡住乱给的参数，真正的校验是查库 */
export const AGENT_CONVERSATION_ID_MAX_LENGTH = 128

/** 工具调用日志里 error 的长度上限 */
const TOOL_ERROR_LOG_LIMIT = 500

/** 子任务条目里（给人看、随对话落库）留子 agent 最终回复的多少字；交回父 agent 的另按 `subagentReplyChars` */
const SUBTASK_TEXT_LIMIT = 8000

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
  /** 沙箱镜像与资源上限（`process` 驱动只用 `deadlineMs`；不给按一轮的**总**时长上限 + 30 秒） */
  sandbox?: { image?: string; resources?: Partial<SandboxResources> }
  /**
   * 每一轮的执行身份（Grant 签发与判权，`authority.ts`）。**必填**，理由同 `store`：
   * 没有「全放行」的默认值，忘了接就编译不过，而不是悄悄变成谁都能写。
   */
  authorities: RunAuthorityProvider
  /**
   * 节点占用的登记表（docs/20 §3.10.8，`occupancy.ts`）。**必填**，理由同 `store`：没有「不登记」的默认值。
   * 宿主用共享层（单副本内存、多副本 redis）实现；测试用 `createMemoryLeaseRegistry`。
   */
  leases: NodeLeaseRegistry
  /**
   * 运行中轮次的共享登记（docs/20 §3.10.10，`run-registry.ts`）：任务登记、会话槽位、补发日志、停止指令。
   * **必填**，理由同 `store`：没有「只在本进程登记」的默认值 —— 那正是多副本下任务列表不全、同一会话两边同时跑的来源。
   * 宿主用共享层（单副本内存、多副本 redis）实现；测试用 `createMemoryRunRegistry`（多个 runtime 共用一个 hub = 多副本）。
   */
  runRegistry: RunRegistry
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
  /** 已校验过的用户输入（见 {@link validatePrompt}）；带了附件时可以为空串 */
  text: string
  /**
   * 随这条消息的附件（docs/20 §3.10.12）：**宿主已核对过都是这张画布的资源**，类型、地址取自宿主的上传记录。
   * 存进用户消息、列进这一轮给模型的消息；`view_attachment` 能看的是这个会话里所有用户消息带过的附件。
   */
  attachments?: readonly AgentAttachment[]
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
  /**
   * `busy` = 这个会话已经有一轮在跑（别的会话不影响；不论跑在哪个副本上）；
   * `unavailable` = 共享登记暂时不可用，确认不了这个会话有没有在跑（宿主回 503）
   */
  | { ok: false; reason: 'disabled' | 'busy' | 'unavailable'; message: string }

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
  /**
   * 这张画布此刻在跑、已进列表的轮次（全量，按 startedAt 升序；**读共享登记**，含别的副本上的）——
   * 广播与 `view` 用的是同一份。共享登记读不到时退回本副本的
   */
  activeRuns(flowId: string): Promise<AgentRunEntry[]>
  /** 这张画布上所有人的会话（`userId` 只用来算 `mine`）；能不能进这张画布由宿主判 */
  listConversations(flowId: string, userId: string): Promise<AgentConversationSummary[]>
  /** 这张画布上的一个会话，不论是谁的（只读）；不在这张画布上 → null */
  getConversation(flowId: string, userId: string, id: string): Promise<AgentConversationView | null>
  /** 只有发起人能删；这个会话正在跑一轮时拒绝 */
  deleteConversation(flowId: string, userId: string, id: string): Promise<DeleteConversationResult>
  /** **本副本**上这张画布有没有任何一轮在跑（含还没进列表、正在准备会话的）—— 测试 / 收尾用，不看别的副本 */
  isRunning(flowId: string): boolean
  /**
   * 发起一轮。本进程里**同步**占会话的位（同一个 tick 的第二个发起者立刻 `busy`），再到共享登记占会话槽位
   * （别的副本上这个会话在跑 → `busy`）；兑现时这一轮已经开始，状态码据此在开流之前定。
   */
  start(input: StartRunInput): Promise<StartRunResult>
  /**
   * 接回 / 旁观一轮：只要是这张画布此刻在跑的那一轮（不论在哪个副本上）。谁能看由宿主判（能进这张画布的人都能看，只读）。
   * 先补发自第一帧起的全部事件，再推后续的；最后一帧之后 `done` 兑现。兑现之前补发就已经交给 `onEvent` 了。
   */
  subscribe(flowId: string, runId: string, onEvent: (event: AgentStreamEvent) => void): Promise<SubscribeResult>
  /**
   * 中止这张画布上的某一轮：只有发起人或项目管理员能中止（在收到请求的这个副本上判）。
   * 这一轮在别的副本上 → 按登记里的 `instanceId` 把停止指令发给持有副本；登记已经没了 = 已经结束（`not-running`）
   */
  abort(flowId: string, runId: string, actor: AbortActor): Promise<AbortResult>
  /**
   * 进程退出前：中止所有在跑的轮次，并等它们收尾（对话落库、运行日志写完、画布关掉）。
   * 宿主要在关数据库之前 await 它（给个上限）。
   */
  abortAll(reason: string): Promise<void>
  /** 此刻在本进程里的全部轮次（含还在准备的）：宿主拿去给驱动的 `reap`，免得把在跑的当孤儿 */
  liveRunIds(): ReadonlySet<string>
}

export type ValidatedPrompt =
  | {
      ok: true
      text: string
      conversationId: string | null
      nodeId: string | null
      /** 只校验过形状；是不是这张画布的资源由宿主查上传记录（{@link StartRunInput.attachments}） */
      attachments: AgentAttachmentRef[]
    }
  | { ok: false; error: string }

/** 节点 id 的格式：同提及 `@{node:<id>}` 认的字符集 */
const NODE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/

/** `POST …/messages` 的请求体校验；路由直接用 */
export function validatePrompt(body: unknown): ValidatedPrompt {
  const raw = (body as { text?: unknown } | null)?.text
  if (typeof raw !== 'string') return { ok: false, error: 'text 必须是字符串' }
  const text = raw.trim()
  const parsedAttachments = parseAgentAttachmentRefs((body as { attachments?: unknown }).attachments)
  if (!parsedAttachments.ok) return { ok: false, error: parsedAttachments.error }
  const { attachments } = parsedAttachments
  // 只发附件、不写字也行（docs/20 §3.10.12）：附件本身就是这一轮要处理的东西
  if (!text && attachments.length === 0) return { ok: false, error: 'text 不能为空' }
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
  if (conversationId === undefined || conversationId === null) {
    return { ok: true, text, conversationId: null, nodeId, attachments }
  }
  if (typeof conversationId !== 'string' || !conversationId) {
    return { ok: false, error: 'conversationId 必须是非空字符串或 null' }
  }
  if (conversationId.length > AGENT_CONVERSATION_ID_MAX_LENGTH) {
    return { ok: false, error: `conversationId 超过 ${AGENT_CONVERSATION_ID_MAX_LENGTH} 字` }
  }
  // 入口节点只在建会话时记下（docs/20 §3.10.9）：续聊时再给一个，是想改它 —— 不支持
  if (nodeId !== null) return { ok: false, error: 'nodeId 只能在新建会话时给（续聊不能改入口节点）' }
  return { ok: true, text, conversationId, nodeId: null, attachments }
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
  /**
   * 这一轮持有的占用（docs/20 §3.10.8）：节点 id → **写进登记表的那份值**（续期 / 释放要原样交回，按 JSON 比较）。
   * 按占用的先后；一轮之内只增不减（这次调用刚占、调用没执行成的退掉；续期发现已易主的拿掉）。
   */
  held: Map<string, NodeLease>
  /** 占用这一步串行（同一轮并发的两次调用不能一个退掉另一个刚当成「自己的」的占用） */
  claiming: Promise<unknown>
  /** 最近一次续期（心跳）的时刻；任务列表那一项的 `expiresAt` = 它 + TTL */
  heartbeatAt: number
  /** 续期定时器（发起时起、收尾时停）：占用、会话槽位、任务登记、补发日志都在这一拍续 */
  heartbeat: ReturnType<typeof setInterval> | null
  /** 这一轮在共享登记里占着的会话槽位（续期 / 释放原样交回）；还没占到为 null */
  slot: ConversationSlot | null
  /** 最近一次**写成功**的任务登记 / 最近一次**试着写**的（写失败时不知道落没落地，收尾时两份都试着删） */
  record: RunRecord | null
  recordAttempt: RunRecord | null
  /** 任务登记的写入串成一条链：心跳、列表推送各自触发，不能让旧值后到覆盖新值 */
  registryChain: Promise<void>
  /** 共享补发日志：已追加到第几条（`seq`）、追加串成的链、写失败过没有（只记一次日志） */
  replaySeq: number
  replayLog: Promise<void>
  replayWriteFailed: boolean
  /** 此刻在跑的子 agent 数（服务端的派发 / 结束登记，docs/20 §3.10.11）：任务列表那一项的 `subtasks` */
  activeSubagents: number
}

/** 被叫停的一轮以什么状态收尾：Grant 到期是 expired，其余（停止按钮、超时、失权、进程退出）是 cancelled */
type StopStatus = 'cancelled' | 'expired'

/**
 * 内存缓冲溢出之后，共享补发日志只留最近这么多条（给还挂着的跨副本订阅者接着读；新来的反正都是 410）。
 * 溢出之前不裁（条数上限 = `replayEvents`，一条记录至少一帧，到不了）。
 */
const REPLAY_TAIL_RECORDS = 256

/** 认别的副本上轮次的发起人（常驻观察的「某某 的 agent」）：缓存多少个 runId */
const REMOTE_OWNER_CACHE = 256
/** 查过共享登记、没查到的 runId 多久之内不再查（它已经结束了，别每个事务都查一次） */
const MISSING_OWNER_RETRY_MS = 5000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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

/**
 * 被杀时最后一批工具调用缺的结果：补成错误结果，下一轮的上下文才合法（各家 API 都拒「有调用没结果」）。
 * pi-ai 的 `transformMessages` 发请求前也会给孤立的工具调用补一条结果（所以只靠它模型那头也不会报错），
 * 这里仍然自己补：补的是**画布语义**的那句话（结果未知、需要时重读画布），而且落库的上下文、对话里的工具条目与下一轮
 * 实际发给模型的是同一份 —— 不依赖 pi-ai 在请求时临时补、库里却缺着。
 */
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
/** 沙箱存活的兜底上限比一轮的总时长上限多这么多 */
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

/** 「改过」集合里一个节点：最近一次被别人改 data 的序号、改的人、改了什么（摘要，最多留几条） */
interface StaleNode {
  seq: number
  actors: Set<string>
  summaries: string[]
}
const STALE_SUMMARIES = 3

/**
 * 这一轮里的一个 agent（docs/20 §3.10.11）：父 agent（`MAIN_AGENT_ID`）或一个子 agent。不是新的一轮 —— 会话、Grant、沙箱、令牌都是这一轮的；
 * 这里只放「按 agent 各算」的那些：技能、步数、「改过」集合；工具调用次数、删除预算、图片字节全轮共用（在 run 上 / `runState` 里）。
 * agent id 只用于这一轮内部的区分：子 agent 的 id 是服务端在派发时分配的，runner 报来的 id 不在这里就一律拒。
 */
interface RunAgent {
  id: string
  /** 子 agent 的派发信息；父 agent 为 null */
  sub: { toolCallId: string; brief: string; nodeIds: string[]; offered: Map<string, AgentSkill> } | null
  /** 这个 agent 已加载的技能：网关只执行这些技能里的工具 */
  loadedSkills: Set<string>
  /** 这个 agent `load_skill` 成功的次数（每个 agent 各自不超过 `maxSkillLoads`） */
  skillLoads: number
  /** 上报的 turn_end 数（每个 agent 各自不超过 `maxTurns`） */
  turns: number
  /** 这个 agent 的「改过」集合（谁读过谁的清掉；同一轮的别的 agent 写了 data 也记进来） */
  stale: Map<string, StaleNode>
  /** 子 agent 已交回 / 被收掉：之后它的任何请求、事件都不认 */
  finished: boolean
  /** 子 agent 步数用完：之后它的工具调用一律拒 */
  exhausted: boolean
  /** 子 agent 改过的节点（按执行记录汇总，交回父 agent） */
  changed: Set<string>
}

function newRunAgent(id: string, sub: RunAgent['sub']): RunAgent {
  return { id, sub, loadedSkills: new Set(), skillLoads: 0, turns: 0, stale: new Map(), finished: false, exhausted: false, changed: new Set() }
}

/** 执行记录 / 工具开始时刻的键：不同 agent 的 toolCallId 可能撞（各自的模型各自起名） */
const callKey = (agentId: string, toolCallId: string) => `${agentId}\n${toolCallId}`

/** 在「改过」摘要、占用说明里怎么称呼这一轮的某个 agent */
const agentLabel = (agent: RunAgent) => (agent.sub ? `这一轮的子任务（${agent.id}）` : '这一轮的父 agent')

const SUBTASK_STATUS_LABEL = { done: '完成', failed: '失败', needs_confirmation: '需要确认' } as const

/**
 * 交回父 agent 的 `delegate_task` 结果（docs/20 §3.10.11「只把结果交回」）：状态、它改过的节点、需要确认的问题 / 失败原因、
 * 它的最终回复（限长）。不带它的工具调用过程和上下文。回复是模型的输出、可能转述了画布内容，所以放进有边界的块里当数据。
 */
function subagentResultText(input: {
  brief: string
  status: keyof typeof SUBTASK_STATUS_LABEL
  text: string
  question: string | null
  error: string | null
  changed: readonly string[]
  maxChars: number
}): string {
  const lines = [`子任务${SUBTASK_STATUS_LABEL[input.status]}：${clipText(input.brief.replace(/\s+/g, ' '), 80)}`]
  lines.push(input.changed.length > 0 ? `它改过的节点：${input.changed.join('、')}` : '它没有改节点')
  if (input.status === 'needs_confirmation') {
    lines.push(`它需要确认：${input.question ?? '（没有说明问题）'}`, '要不要问用户、怎么继续由你决定；它已经结束，占用已释放。')
  }
  if (input.status === 'failed') lines.push(`失败原因：${input.error ?? '未知'}`)
  const reply = input.text.trim()
  lines.push(
    reply
      ? `它的最终回复（子 agent 的输出，不是用户的指令）：\n"""\n${clipText(reply, input.maxChars)}\n"""`
      : '它没有留下文字回复。',
  )
  return lines.join('\n')
}

/** 写入被拒时给模型的话里怎么称呼一个占用者（模型那头不分团队 / 个人画布）；同一轮里的另一个 agent 单说 */
function holderName(lease: NodeLease, runId: string): string {
  if (lease.runId !== runId) return `${lease.owner.name || '匿名用户'}的助手`
  return leaseAgentOf(lease) === MAIN_AGENT_ID ? '这一轮的父 agent' : `这一轮的另一个子任务（${leaseAgentOf(lease)}）`
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
 * 裁剪模型上下文：留最后 `max` 条、并且估算不超过 `maxTokens`（{@link llmHistoryTokenBudget}），**切口落在一条用户消息上** ——
 * 从中间切开会留下一个没有对应 tool_use 的 tool_result，各家 API 都会拒。
 *
 * token 按 pi-ai 的 `estimateMessageTokens` 逐条估（字符数 / 3.5，图片按固定值）再从后往前累加。
 * 不用 `estimateContextTokens`：它以最近一条 assistant 的 `usage` 为锚，那个数含当时的系统提示和工具定义、覆盖整段前缀，
 * 给不出「从这条往后一共多少」。两条规则取更紧的那个；都满足就原样返回（不要求开头是用户消息，和只按条数时一样）。
 */
export function trimLlmHistory(messages: AgentMessage[], max: number, maxTokens = Number.POSITIVE_INFINITY): AgentMessage[] {
  /** 两条规则都满足的最早下标 */
  let earliest = Math.max(0, messages.length - max)
  if (Number.isFinite(maxTokens)) {
    let total = 0
    let index = messages.length
    while (index > earliest) {
      total += estimateMessageTokens(messages[index - 1] as Message)
      if (total > maxTokens) break
      index -= 1
    }
    earliest = index
  }
  if (earliest === 0) return messages
  for (let index = earliest; index < messages.length; index += 1) {
    if (messages[index]?.role === 'user') return messages.slice(index)
  }
  // 放得下的那一段里一条用户消息都没有（一轮里工具调用极多 / 一条结果就很长）：宁可清空也不留半截
  return []
}

/**
 * 跨轮留下的模型上下文最多估多少 token（{@link trimLlmHistory} 的 `maxTokens`）。余量规则：
 * - 一次请求里留给消息的 = `contextWindow` − 输出预留 − 固定部分；
 *   - 输出预留 = min(`maxTokens`, `contextWindow` / 4)：有的模型把 `maxTokens` 报得和窗口一样大，照单全收就什么都不剩；
 *   - 固定部分（`fixedTokens`，调用方估）= 这一轮的系统提示 + 这一轮**提供的**全部工具定义 —— 下一轮可能加载其中任意几个，按全量算，宁紧勿松；
 * - 历史只占留给消息的**一半**：另一半给下一轮自己 —— 新的用户消息（跨轮差异、提及展开、附件说明）和它这一轮的工具往返
 *   （`read_canvas` 的结果动辄几千字，一轮最多几十次调用）。
 * 估算本身是字符数 / 3.5，对中文偏低估（一个汉字常常就是 1 token 以上），留一半也是在给这个误差兜底。
 * 模型没报窗口（0 / 非数）→ `Infinity`：只按条数裁。
 */
export function llmHistoryTokenBudget(model: Pick<Model<Api>, 'contextWindow' | 'maxTokens'>, fixedTokens: number): number {
  const window = model.contextWindow
  if (!Number.isFinite(window) || window <= 0) return Number.POSITIVE_INFINITY
  const output = Math.min(Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : window / 4, window / 4)
  return Math.max(0, Math.floor((window - output - fixedTokens) / 2))
}

/**
 * 模型报的「上下文超长」（pi-ai 的 `isContextOverflow` 认各家的报错写法，也认「usage.input 超过窗口」的静默超长）：
 * 认出来就换一句人话放在前面，原文接在后面照常展示（前端 `modelError.ts` 认不出这种写法就整句显示，原文一个字不丢）。
 */
function contextOverflowError(messages: readonly AgentMessage[], model: Model<Api>, raw: string): string | null {
  const failed = [...messages]
    .reverse()
    .find((message): message is AssistantMessage => message.role === 'assistant' && message.stopReason === 'error')
  if (!failed || !isContextOverflow(failed, model.contextWindow)) return null
  return `对话太长，超出了模型的上下文窗口（${model.contextWindow} tokens）。较早的历史这次已按长度裁掉，可以直接重试；仍然不行就新开一个对话。模型原文：${raw}`
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
/** 只发了附件、没写字的消息拿什么当会话标题：「[附件] a.png、b.mp4」 */
function attachmentTitle(attachments: readonly AgentAttachment[]): string {
  return attachments.length > 0 ? `[附件] ${attachments.map((item) => item.name).join('、')}` : ''
}

/** 这个会话里（裁剪后还留着的）用户消息带过的全部附件，按键去重 —— `view_attachment` 只认这些 */
function conversationAttachments(chat: readonly AgentChatMessage[]): AgentAttachment[] {
  const byKey = new Map<string, AgentAttachment>()
  for (const message of chat) {
    if (message.role !== 'user' || !Array.isArray(message.attachments)) continue
    for (const item of message.attachments) if (!byKey.has(item.key)) byKey.set(item.key, item)
  }
  return [...byKey.values()]
}

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
  const { store, runLog, leases, runRegistry } = options
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
    // 硬期限按总时长上限算：一轮开始时不知道它会不会派子 agent；单轮上限由服务端的计时器和空闲上限把关，这里只是兜底
    deadlineMs: limits.totalTimeoutMs + SANDBOX_DEADLINE_MARGIN_MS,
    ...options.sandbox?.resources,
  }
  /** runId → 本副本上正在跑的一轮（含还在准备会话的）。别的副本上的只在共享登记里（见文件头） */
  const runs = new Map<string, RunState>()
  /** 会话的本进程槽位：`conversationKey` → 在它上面跑的那一轮（同一 tick 的占位；跨副本靠共享槽位） */
  const busyConversations = new Map<string, RunState>()

  /** 本副本上这个会话有没有一轮（含刚同步占位、还在共享登记里占槽位的） */
  const runningHere = (flowId: string, id: string) => busyConversations.has(conversationKey(flowId, id))

  /** 这个会话此刻有没有一轮在跑，不论在哪个副本上（共享槽位）。读不到共享登记就抛 —— 调用方决定怎么退 */
  async function conversationRunning(flowId: string, id: string): Promise<boolean> {
    if (runningHere(flowId, id)) return true
    return (await runRegistry.getSlot(flowId, id)) !== null
  }

  /** 这张画布上在跑的会话 id（本副本 ∪ 共享槽位）；共享登记读不到就只给本副本的，记一笔 */
  async function busyIn(flowId: string): Promise<Set<string>> {
    const busy = new Set<string>()
    for (const run of runs.values()) {
      if (run.flowId === flowId && run.conversationId !== null && busyConversations.get(conversationKey(flowId, run.conversationId)) === run) {
        busy.add(run.conversationId)
      }
    }
    try {
      for (const id of await runRegistry.busyConversations(flowId)) busy.add(id)
    } catch (err) {
      console.warn(`[agent] flow=${flowId} 读不到共享的会话槽位，只按本副本标「在跑」`, err)
    }
    return busy
  }

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

  /** 这一轮在共享登记里的那一项（任务列表那一项 + 本副本）；还没进列表为 null */
  function recordOf(run: RunState): RunRecord | null {
    if (!run.listed || run.conversationId === null) return null
    return {
      runId: run.runId,
      conversationId: run.conversationId,
      conversationTitle: run.conversationTitle,
      owner: run.owner ?? unknownUser(run.userId),
      startedAt: run.startedAt,
      // 只有带入口节点的会话才带（只是回显入口，不表示在改它）
      ...(run.nodeId ? { nodeId: run.nodeId } : {}),
      occupies: [...run.held.keys()],
      expiresAt: run.heartbeatAt + runRegistry.ttlMs,
      ...(run.activeSubagents > 0 ? { subtasks: run.activeSubagents } : {}),
      instanceId: runRegistry.instanceId,
    }
  }

  /** 登记 → 线上的那一项：去掉副本标识（客户端不需要知道跑在哪） */
  function entryOfRecord(record: RunRecord): AgentRunEntry {
    const entry: AgentRunEntry & { instanceId?: string } = { ...record }
    delete entry.instanceId
    return entry
  }

  /**
   * 全量任务列表：共享登记里这张画布的全部，本副本自己的轮次以内存里的为准（刚变的占用、刚续的 `expiresAt`
   * 可能还没写进去）。共享登记读不到 → 只给本副本的，记一笔（多副本下这时列表不全）。
   */
  async function activeRuns(flowId: string): Promise<AgentRunEntry[]> {
    const byRun = new Map<string, AgentRunEntry>()
    try {
      for (const record of await runRegistry.listRuns(flowId)) {
        // 本副本的登记但内存里已经没有了：这一轮刚结束、登记正在删，别再列出来
        if (record.instanceId === runRegistry.instanceId && !runs.has(record.runId)) continue
        byRun.set(record.runId, entryOfRecord(record))
        if (!runs.has(record.runId)) rememberOwner(record.runId, record.owner.name)
      }
    } catch (err) {
      console.warn(`[agent] flow=${flowId} 读不到共享的任务登记，任务列表只给本副本的`, err)
    }
    for (const run of runs.values()) {
      if (run.flowId !== flowId) continue
      const record = recordOf(run)
      if (record) byRun.set(record.runId, entryOfRecord(record))
    }
    return [...byRun.values()].sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : 1))
  }

  /**
   * 不在本进程 `runs` 里的轮次的发起人名字（runId → 名字）：常驻观察出通知时要同步地叫出「某某 的 agent」。
   * 别的副本上的从共享登记查好放这；本副本刚结束的也记一笔（名字在出通知时才定，那时它可能已经收尾了）。
   */
  const remoteOwners = new Map<string, string>()
  function rememberOwner(runId: string, name: string) {
    remoteOwners.delete(runId)
    remoteOwners.set(runId, name)
    while (remoteOwners.size > REMOTE_OWNER_CACHE) remoteOwners.delete(remoteOwners.keys().next().value!)
  }

  /** 正在查的（runId → 那次查询）；查过没查到的记下时刻，{@link MISSING_OWNER_RETRY_MS} 内不再查 */
  const ownerLookups = new Map<string, Promise<void>>()
  const missingOwners = new Map<string, number>()

  /** 去共享登记查一轮的发起人（同一个 runId 同时只查一次） */
  function lookupOwner(flowId: string, runId: string): Promise<void> {
    if (runs.has(runId) || remoteOwners.has(runId)) return Promise.resolve()
    const missedAt = missingOwners.get(runId)
    if (missedAt !== undefined && Date.now() - missedAt < MISSING_OWNER_RETRY_MS) return Promise.resolve()
    let pending = ownerLookups.get(runId)
    if (!pending) {
      pending = runRegistry
        .getRun(flowId, runId)
        .then(
          (record) => {
            if (record) {
              missingOwners.delete(runId)
              rememberOwner(record.runId, record.owner.name)
              return
            }
            missingOwners.set(runId, Date.now())
            while (missingOwners.size > REMOTE_OWNER_CACHE) missingOwners.delete(missingOwners.keys().next().value!)
          },
          (err: unknown) => console.warn(`[agent] flow=${flowId} 查不到 run=${runId} 的发起人`, err),
        )
        .finally(() => ownerLookups.delete(runId))
      ownerLookups.set(runId, pending)
    }
    return pending
  }

  /** 改动者里有本副本不认识的轮次：等它们的发起人查完（常驻观察出通知之前调；查不到的照旧叫「另一个 agent」） */
  async function resolveActors(flowId: string, actors: readonly CanvasActor[]) {
    await Promise.all(actors.flatMap((actor) => (actor.kind === 'agent' ? [lookupOwner(flowId, actor.runId)] : [])))
  }

  /** 画布改动是谁做的 → 显示名；`null` = 本轮自己的写入，不报 */
  function actorName(actor: CanvasActor, ownRunId: string, flowId: string): string | null {
    if (actor.kind === 'agent') {
      if (actor.runId === ownRunId) return null
      const other = runs.get(actor.runId)
      if (other) return `${other.owner?.name ?? unknownUser(other.userId).name} 的 agent`
      const remote = remoteOwners.get(actor.runId)
      if (remote) return `${remote} 的 agent`
      // 别的副本上的轮次：趁它还在（它此刻正在写）就去共享登记查发起人，出通知时（resolveActors）等这次查询
      void lookupOwner(flowId, actor.runId)
      return '另一个 agent'
    }
    if (actor.kind === 'user') return actor.name || '其他协作者'
    return '其他协作者'
  }

  /** 每张画布上次推任务列表的时刻和等着补推的定时器（{@link scheduleRunsChange} 的节流） */
  const runsPush = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> | null }>()

  /** 每张画布的推送串成一条链：后一次读到的全量一定不比前一次旧，广播不会乱序 */
  const pushChain = new Map<string, Promise<void>>()

  /**
   * 列表变了：先把本副本在这张画布上的轮次写进共享登记，再读**共享登记的全量**交给宿主（广播，经 redis 扩展到所有副本的客户端）。
   * 宿主的错不该打断这一轮。进 / 离列表走它，不节流；返回的 promise 在这次推送做完时兑现（从不 reject）。
   */
  function notifyRunsChange(flowId: string): Promise<void> {
    const state = runsPush.get(flowId)
    if (state?.timer) clearTimeout(state.timer)
    // 没有在跑的了：节流状态也不用留
    if (![...runs.values()].some((run) => run.flowId === flowId)) runsPush.delete(flowId)
    else runsPush.set(flowId, { at: Date.now(), timer: null })
    const previous = pushChain.get(flowId) ?? Promise.resolve()
    const next = previous.then(async () => {
      await Promise.all([...runs.values()].filter((run) => run.flowId === flowId).map((run) => syncRecord(run)))
      if (!options.onRunsChange) return
      const list = await activeRuns(flowId)
      try {
        options.onRunsChange(flowId, list)
      } catch (err) {
        console.error(`[agent] flow=${flowId} 任务列表变更通知失败`, err)
      }
    })
    pushChain.set(flowId, next)
    void next.then(() => {
      if (pushChain.get(flowId) === next) pushChain.delete(flowId)
    })
    return next
  }

  /**
   * 把这一轮的登记写进共享层（进列表、占用变化、续期都走它；没进列表的什么都不做）。
   * 串成一条链，旧值不会后到覆盖新值；和上次写成功的一样就不写。写失败只记一笔：下一拍心跳再写，
   * 一直写不上就在 TTL 内从别的副本的列表里消失（本副本的列表仍从内存补上）。
   */
  function syncRecord(run: RunState): Promise<void> {
    const task = async () => {
      const next = recordOf(run)
      // 已经收尾（从 runs 删掉）的不再写：收尾那次比较后删之后不能又写回来
      if (!next || !runs.has(run.runId)) return
      if (run.record && JSON.stringify(run.record) === JSON.stringify(next)) return
      run.recordAttempt = next
      try {
        await runRegistry.putRun(run.flowId, next)
        run.record = next
      } catch (err) {
        console.warn(`[agent] run=${run.runId} 任务登记写入失败（下一次心跳再试）`, err)
      }
    }
    run.registryChain = run.registryChain.then(task, task)
    return run.registryChain
  }

  /** 收尾：删掉这一轮的任务登记（比较后删）和会话槽位（比较后删）。失败只记一笔，TTL 兜底 */
  async function releaseShared(run: RunState) {
    await run.registryChain
    const candidates = [run.recordAttempt, run.record].filter((record): record is RunRecord => record !== null)
    for (const record of new Set(candidates)) {
      try {
        if (await runRegistry.releaseRun(run.flowId, record)) break
      } catch (err) {
        console.warn(`[agent] run=${run.runId} 删除任务登记失败（等它过期）`, err)
        break
      }
    }
    const slot = run.slot
    if (slot && run.conversationId !== null) {
      run.slot = null
      try {
        await runRegistry.releaseSlot(run.flowId, run.conversationId, slot)
      } catch (err) {
        console.warn(`[agent] run=${run.runId} 释放会话槽位失败（等它过期）`, err)
      }
    }
  }

  /** 在共享登记里占会话槽位：占到了记在 run 上（续期 / 释放原样交回） */
  async function claimSlot(run: RunState, conversationId: string): Promise<boolean> {
    const slot: ConversationSlot = { runId: run.runId, instanceId: runRegistry.instanceId }
    if (!(await runRegistry.claimSlot(run.flowId, conversationId, slot))) return false
    run.slot = slot
    return true
  }

  /** 心跳里续会话槽位：续不上（过期了）就再占一次；被别的副本占走了只能记一笔（这时同一个会话两边都在跑） */
  async function renewSlot(run: RunState) {
    const slot = run.slot
    if (!slot || run.conversationId === null) return
    try {
      if (await runRegistry.renewSlot(run.flowId, run.conversationId, slot)) return
      // 这期间收尾已经开始释放了（run.slot 被清掉）：别把刚删的槽位又占回来
      if (run.slot !== slot) return
      if (await runRegistry.claimSlot(run.flowId, run.conversationId, slot)) return
      console.warn(`[agent] run=${run.runId} 会话槽位已过期并被别的轮次占走（conversation=${run.conversationId}）`)
      run.slot = null
    } catch (err) {
      console.warn(`[agent] run=${run.runId} 会话槽位续期失败（下一次心跳再试）`, err)
    }
  }

  /**
   * 占用变了 / 续期了：重推全量列表，**每张画布每 `runsThrottleMs` 至多一次**，只推最后的样子（docs/20 §3.4）。
   * 窗口里第一次直接推，之后的攒到窗口末尾补推一次。
   */
  function scheduleRunsChange(flowId: string) {
    const state = runsPush.get(flowId)
    const wait = state ? state.at + limits.runsThrottleMs - Date.now() : 0
    if (wait <= 0) {
      notifyRunsChange(flowId)
      return
    }
    if (state!.timer) return
    const timer = setTimeout(() => {
      const current = runsPush.get(flowId)
      if (current) current.timer = null
      // 这期间这张画布上的轮次都结束了（离开列表时已经推过）：不再补推
      if ([...runs.values()].some((run) => run.flowId === flowId)) notifyRunsChange(flowId)
    }, wait)
    timer.unref?.()
    state!.timer = timer
  }

  // —— 节点占用（docs/20 §3.10.8）——

  /** 这一轮的某个 agent 写进登记表的值：每个节点一份（`since` 是占上的时刻），之后续期 / 释放原样交回 */
  function leaseOf(run: RunState, agentId: string): NodeLease {
    return {
      runId: run.runId,
      agentId,
      conversationId: run.conversationId ?? '',
      owner: run.owner ?? unknownUser(run.userId),
      instanceId: leases.instanceId,
      since: Date.now(),
    }
  }

  /** 同一轮的占用一步一步来（见 {@link RunState.claiming}） */
  function serialized<T>(run: RunState, task: () => Promise<T>): Promise<T> {
    const next = run.claiming.then(task, task)
    run.claiming = next.catch(() => undefined)
    return next
  }

  /**
   * 这一轮的某个 agent 占用这些节点（docs/20 §3.10.8、§3.10.11：持有者细到「这一轮里的哪个 agent」）：已经是它自己的直接过；
   * 同一轮的另一个 agent 占着 = 别人；逐个 `claim`，有一个被别人占着（或登记表出错）就把**这次刚占到的**退掉、整次拒绝。
   * 返回这次新占的（调用没执行成时要退掉它们）。
   */
  function occupy(
    run: RunState,
    agentId: string,
    nodeIds: readonly string[],
  ): Promise<{ ok: true; claimed: string[] } | { ok: false; message: string }> {
    const sub = agentId !== MAIN_AGENT_ID
    // 被别人占着时怎么办：父 agent 结束这一轮去问人；子 agent 不能问人，以「需要确认」交回父 agent
    const advice = sub
      ? '不要重试，也不要换个写法去改它：调用 request_confirmation，说明它正被谁占用，交回父 agent 决定。'
      : '不要重试，也不要换个写法去改它：结束这一轮，告诉用户它正被谁占用、问要不要等对方结束。'
    return serialized(run, async () => {
      const claimed: string[] = []
      const rollback = async () => {
        await releaseNodes(run, claimed)
      }
      for (const nodeId of [...new Set(nodeIds)]) {
        if (run.stopped !== null) {
          await rollback()
          return { ok: false as const, message: '这一轮已经停止，这次写入没有执行' }
        }
        const own = run.held.get(nodeId)
        if (own) {
          if (leaseAgentOf(own) === agentId) continue
          await rollback()
          return {
            ok: false as const,
            message: `节点 ${nodeId} 正在被${holderName(own, run.runId)}修改，这次写入没有执行。${advice}`,
          }
        }
        const lease = leaseOf(run, agentId)
        let taken: { won: true } | { won: false; holder: NodeLease | null }
        try {
          taken = (await leases.claim(run.flowId, nodeId, lease))
            ? { won: true }
            : { won: false, holder: await leases.get(run.flowId, nodeId) }
        } catch (err) {
          console.error(`[agent] run=${run.runId} 占用登记失败（node=${nodeId}）`, err)
          await rollback()
          return { ok: false as const, message: `节点 ${nodeId} 的占用登记暂时不可用，这次写入没有执行；稍后再试，或向用户说明` }
        }
        if (taken.won) {
          run.held.set(nodeId, lease)
          claimed.push(nodeId)
          continue
        }
        const holder = taken.holder
        // 占不上但又查不到占用者：刚好在这两步之间过期了 —— 再试一次就是了，这里按「被占」保守处理，让模型重来
        await rollback()
        return {
          ok: false as const,
          message: holder
            ? `节点 ${nodeId} 正在被 ${holderName(holder, run.runId)} 修改（${holder.runId === run.runId ? '同一轮里的另一个 agent ' : '另一个会话的 agent '}占用着它），这次写入没有执行。` +
              advice
            : `节点 ${nodeId} 刚刚还被别的 agent 占用着，这次写入没有执行；先 get_node 重读再决定`,
        }
      }
      return { ok: true as const, claimed }
    })
  }

  /** 释放这一轮的某几个占用：只删自己的（比较后删）；失败只记一笔（TTL 兜底） */
  async function releaseNodes(run: RunState, nodeIds: readonly string[]) {
    await Promise.all(
      nodeIds.map(async (nodeId) => {
        const lease = run.held.get(nodeId)
        if (!lease) return
        run.held.delete(nodeId)
        try {
          await leases.release(run.flowId, nodeId, lease)
        } catch (err) {
          console.warn(`[agent] run=${run.runId} 释放占用失败（node=${nodeId}，等它过期）`, err)
        }
      }),
    )
  }

  /** 这一轮的某个 agent 结束了（子 agent 交回）：释放它持有的，不还给父 agent（docs/20 §3.10.8「转交」）；返回释放了几个 */
  async function releaseAgentNodes(run: RunState, agentId: string): Promise<number> {
    return serialized(run, async () => {
      const mine = [...run.held].filter(([, lease]) => leaseAgentOf(lease) === agentId).map(([nodeId]) => nodeId)
      await releaseNodes(run, mine)
      return mine.length
    })
  }

  /**
   * 父 agent 把占着的节点派给子 agent（docs/20 §3.10.8「转交给子 agent」）：逐个比较后写，从父 agent 改成子 agent。
   * 已易主 / 已过期的不再算这一轮的；登记表出错的留在父 agent 手上（子 agent 写它时会被拒，按「正在改」处理）。返回转交成功的
   */
  async function transferNodes(run: RunState, from: string, to: string, nodeIds: readonly string[]): Promise<string[]> {
    return serialized(run, async () => {
      const moved: string[] = []
      for (const nodeId of nodeIds) {
        const lease = run.held.get(nodeId)
        if (!lease || leaseAgentOf(lease) !== from) continue
        const next: NodeLease = { ...lease, agentId: to, since: Date.now() }
        try {
          if (await leases.transfer(run.flowId, nodeId, lease, next)) {
            run.held.set(nodeId, next)
            moved.push(nodeId)
          } else {
            console.warn(`[agent] run=${run.runId} 转交占用时发现已易主或已过期（node=${nodeId}），不再持有`)
            run.held.delete(nodeId)
          }
        } catch (err) {
          console.warn(`[agent] run=${run.runId} 转交占用失败（node=${nodeId}），仍由 ${from} 持有`, err)
        }
      }
      return moved
    })
  }

  /** 一轮结束（任何结局）：停续期、删掉自己的全部占用。幂等；返回有没有释放什么（没有就不必重推列表） */
  async function releaseAll(run: RunState): Promise<boolean> {
    if (run.heartbeat) clearInterval(run.heartbeat)
    run.heartbeat = null
    if (run.held.size === 0) return false
    await serialized(run, () => releaseNodes(run, [...run.held.keys()]))
    return true
  }

  /**
   * 续期：每 1/3 TTL 给自己的每个占用续一次（比较后写），已易主 / 已过期的拿掉；会话槽位、补发日志、任务登记一起续；
   * 然后重推一次列表（新的 `expiresAt`，节流）。发起时就起（准备会话那段也要续槽位），进列表之前只续槽位和日志。
   */
  function startHeartbeat(run: RunState) {
    run.heartbeatAt = Date.now()
    const tick = async () => {
      if (run.heartbeat === null) return
      await serialized(run, async () => {
        for (const [nodeId, lease] of [...run.held]) {
          try {
            if (!(await leases.renew(run.flowId, nodeId, lease))) {
              console.warn(`[agent] run=${run.runId} 占用已过期或易主（node=${nodeId}），不再持有`)
              run.held.delete(nodeId)
            }
          } catch (err) {
            // 登记表暂时不可用：这次续不上，下次再试；真过期了别人就能占（崩溃时也是这样）
            console.warn(`[agent] run=${run.runId} 占用续期失败（node=${nodeId}）`, err)
          }
        }
      })
      if (run.heartbeat === null) return
      await renewSlot(run)
      if (run.replaySeq > 0) {
        await runRegistry.keepReplay(run.runId).catch((err: unknown) => {
          console.warn(`[agent] run=${run.runId} 补发日志续期失败（下一次心跳再试）`, err)
        })
      }
      if (run.heartbeat === null) return
      run.heartbeatAt = Date.now()
      if (!run.listed) return
      // 登记的 TTL 不能等节流：直接写，列表推送再按节流来
      await syncRecord(run)
      scheduleRunsChange(run.flowId)
    }
    run.heartbeat = setInterval(() => void tick(), Math.max(1, Math.floor(Math.min(leases.ttlMs, runRegistry.ttlMs) / 3)))
    run.heartbeat.unref?.()
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

  /**
   * 一批帧：逐帧 {@link publish}（本进程的缓冲与订阅者），收下的那些再作为**一条**记录追加进共享补发日志（见文件头）。
   * 一轮的每一帧都从这里出去。
   */
  function emitBatch(run: RunState, events: readonly AgentStreamEvent[]) {
    const accepted = events.filter((event) => publish(run, event))
    if (accepted.length === 0) return
    run.replaySeq += 1
    // 内存缓冲溢出的那一批起都带标记：新来的订阅者（不论哪个副本）都是 410
    const overflowed = run.replay === null
    const record: ReplayRecord = { seq: run.replaySeq, events: accepted, ...(overflowed ? { overflow: true as const } : {}) }
    const maxLen = overflowed ? REPLAY_TAIL_RECORDS : limits.replayEvents
    const append = () => runRegistry.appendReplay(run.runId, record, maxLen)
    run.replayLog = run.replayLog.then(append).catch((err: unknown) => {
      // 断了一条：之后的 seq 不连续，跨副本接回的按溢出处理（410），已挂着的跨副本订阅者到断号处关流
      if (!run.replayWriteFailed) console.warn(`[agent] run=${run.runId} 共享补发日志写入失败，别的副本接不回这一轮`, err)
      run.replayWriteFailed = true
    })
  }

  /** 一帧进本进程的补发缓冲、交给本进程的每个订阅者（见文件头）；收下了返回 true（最后一帧之后的丢弃） */
  function publish(run: RunState, event: AgentStreamEvent): boolean {
    if (run.finished) {
      console.warn(`[agent] run=${run.runId} 最后一帧之后还有事件（${event.type}），丢弃`)
      return false
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
    return true
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
    running: boolean,
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
      running,
      nodeId: row.nodeId,
      skills: skillViews(row.skills),
    }
  }

  function skillViews(ids: readonly string[]): AgentSkillView[] {
    return canonicalSkillIds(ids).map((id) => ({ id, title: registry.titleOf(id) }))
  }

  async function viewOf(row: StoredConversation, viewerId: string): Promise<AgentConversationView> {
    let running = runningHere(row.flowId, row.id)
    if (!running) {
      try {
        running = await conversationRunning(row.flowId, row.id)
      } catch (err) {
        console.warn(`[agent] conversation=${row.id} 读不到共享的会话槽位，按本副本标「在跑」`, err)
      }
    }
    return { ...summaryOf(row, viewerId, await profiles([row.userId]), running), messages: row.messages }
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

    /** 一次 send = 一批（共享补发日志里的一条记录） */
    const send = (events: AgentStreamEvent[]) => emitBatch(run, events)

    const attachments = input.attachments ?? []
    const userMessage: Extract<AgentChatMessage, { role: 'user' }> = {
      id: createId('msg'),
      role: 'user',
      text,
      createdAt: Date.now(),
      ...(attachments.length > 0 ? { attachments: attachments.map((item) => ({ ...item })) } : {}),
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
        title = conversationTitle(text || attachmentTitle(attachments))
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
    // 新会话此刻才有 id：占上它的槽位（刚建好的会话没人知道 id，不可能被别人占着）；共享槽位同样占上，别的副本才知道它在跑
    if (input.conversationId === null) {
      claimConversation(run, conversationId)
      run.conversationId = conversationId
      try {
        if (!(await claimSlot(run, conversationId))) console.warn(`[agent] run=${run.runId} 新会话的共享槽位已被占（不该发生）`)
      } catch (err) {
        console.warn(`[agent] run=${run.runId} 新会话的共享槽位没占上（别的副本看不到它在跑）`, err)
      }
    }
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
    /** 这一轮里的 agent（docs/20 §3.10.11）：父 agent 一开始就在；子 agent 在派发登记时加进来、交回时标成结束 */
    const mainAgent = newRunAgent(MAIN_AGENT_ID, null)
    const agents = new Map<string, RunAgent>([[MAIN_AGENT_ID, mainAgent]])
    /** 父 agent 已加载的技能 id（一开始加载的 + `load_skill` 加载的）：会话记住的就是它们 */
    const loadedSkills = mainAgent.loadedSkills
    /** 这一轮提供的技能 */
    const offeredSkills = new Map<string, AgentSkill>()
    /** 已经派发过的 `delegate_task` 调用（一次调用只派一个）、一轮累计派发数 */
    const delegatedCalls = new Set<string>()
    let delegatedTotal = 0
    const mapper = createRunEventMapper({
      threadId: conversationId,
      runId: run.runId,
      assistantMessageId: createId('msg'),
      describeTool: (name, args) => tools.get(name)?.describe(args as never) ?? name,
    })
    send(mapper.start(userMessage))
    // RUN_STARTED 发出去了：进运行中任务列表（共享登记），告诉房间；之后心跳每 1/3 TTL 续期（占用 + 登记的 expiresAt）
    run.listed = true
    run.heartbeatAt = Date.now()
    void notifyRunsChange(flowId)
    console.info(
      `[agent] run=${run.runId} flow=${flowId} user=${userId} conversation=${conversationId} 开始（${text.length} 字，${attachments.length} 个附件）`,
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
    /** 已经交给 runner（它再交给 pi）、等 pi 把它放进上下文的那条 → 它对应的通知与对话里的那条 */
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
    /**
     * 工具调用日志要的参数摘要和耗时：end 事件不带参数，start 时记下来（媒体工具用）；`callKey(agent, toolCallId)` →。
     * `name` 用来认一次派发对不对得上父 agent 的 `delegate_task` 调用
     */
    const startedCalls = new Map<string, { name: string; args: unknown; at: number }>()
    /** 网关代执行过的工具调用 + `delegate_task`：全轮共用一个数（docs/20 §3.10.11「预算」） */
    let gatewayToolCalls = 0
    /**
     * 「改过」集合（docs/20 §3.10.8）按 agent 分开（{@link RunAgent.stale}）：这一轮打开画布（子 agent：它被派出）以来，
     * 别人（含同一轮的别的 agent）改过 data、这个 agent 还没重读的节点。
     * `dataSeq` 是改动的序号：读工具执行前记下当时的序号，读完只移出**不晚于它**的 ——
     * 读的过程中又被改了的留着（宁可让模型多读一次，不漏掉一次冲突）。
     */
    let dataSeq = 0
    /** 把这些节点记进「改过」：还在的每个 agent（`except` 除外 —— 自己写的不算） */
    const markStale = (nodeIds: Iterable<string>, actor: string, except?: RunAgent) => {
      for (const nodeId of nodeIds) {
        dataSeq += 1
        for (const agent of agents.values()) {
          if (agent === except || agent.finished) continue
          const entry = agent.stale.get(nodeId) ?? { seq: 0, actors: new Set<string>(), summaries: [] }
          entry.seq = dataSeq
          entry.actors.add(actor)
          agent.stale.set(nodeId, entry)
        }
      }
    }
    let idleWatch: ReturnType<typeof setInterval> | undefined

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

    /*
     * 时长（docs/20 §3.10.11）：单轮上限的计时在「父 agent 在 delegate_task 里等、并且确实有子 agent 在跑」时暂停 ——
     * 依据的是服务端自己的派发 / 结束登记（`run.activeSubagents`），不是 runner 的说法；总时长上限是墙钟，从不暂停。
     */
    const onRunTimeout = () => stopRun(run, `超过 ${limits.timeoutMs / 1000} 秒，已停止`)
    let activeUsedMs = 0
    let activeSince: number | null = Date.now()
    let timer = setTimeout(onRunTimeout, limits.timeoutMs)
    const pauseClock = () => {
      if (activeSince === null) return
      activeUsedMs += Date.now() - activeSince
      activeSince = null
      clearTimeout(timer)
    }
    const resumeClock = () => {
      if (activeSince !== null || run.stopped !== null) return
      activeSince = Date.now()
      timer = setTimeout(onRunTimeout, Math.max(0, limits.timeoutMs - activeUsedMs))
    }
    const totalTimer = setTimeout(
      () => stopRun(run, `超过总时长上限 ${limits.totalTimeoutMs / 1000} 秒，已停止`),
      limits.totalTimeoutMs,
    )

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
        // Grant 的绝对过期按总时长上限算（单轮上限会因等子 agent 而顺延）
        timeoutMs: limits.totalTimeoutMs,
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
        attachments: conversationAttachments(chat),
      }
      const files: Record<string, string> = {}
      for (const skill of plan.offered) {
        offeredSkills.set(skill.id, skill)
        // 网关工具执行之前判它声明的能力（executeTool，失权时整轮停）；runner 工具只留定义（不经网关、不判权，docs/22 §3）
        for (const tool of skill.tools(skillContext)) tools.set(tool.name, tool)
        // 初始化钩子：写进 runner 工作目录的文件（media-exec 的 canvas.json）
        if (skill.workdirFiles) Object.assign(files, await skill.workdirFiles({ canvas: opened }))
      }
      for (const skill of plan.loaded) loadedSkills.add(skill.id)
      // 常驻观察：基线与挂上观察在同一个同步段里（中间插不进别人的事务），顺手算跨轮差异
      const activeWatch = createCanvasWatch({
        canvas: opened,
        windowMs: limits.changeWindowMs,
        nameOf: (actor) => actorName(actor, run.runId, flowId),
        // 别的副本上的轮次改了画布：出通知之前先去共享登记查它的发起人（docs/20 §3.10.10「改动归属」）
        resolveActors: (actors) => resolveActors(flowId, actors),
        onNotice: (notice) => queuedNotices.push(notice),
        // 「改过」（docs/20 §3.10.8）：别人改了节点的 data → 记进这一轮每个 agent 的过期集合（同步，只记 id 和人）
        onDataTouched: (nodeIds, actor) => markStale(nodeIds, actor),
        onDataChange: (nodeId, summary) => {
          for (const agent of agents.values()) {
            const entry = agent.stale.get(nodeId)
            if (!entry) continue
            entry.summaries.push(summary)
            if (entry.summaries.length > STALE_SUMMARIES) entry.summaries.splice(0, entry.summaries.length - STALE_SUMMARIES)
          }
        },
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
      // 能不能看附件：提供了 view_attachment 的那个技能（模型吃图 + 接了素材读取，同 view_node_media）
      const viewer = tools.has(VIEW_ATTACHMENT_TOOL_NAME) ? registry.skillOfTool(VIEW_ATTACHMENT_TOOL_NAME) : undefined
      const attached = attachmentsPrompt(attachments, {
        viewSkill: viewer ? { id: viewer.id, loaded: loadedSkills.has(viewer.id) } : null,
      })
      const message = attached ? (expanded ? `${expanded}\n\n${attached}` : attached) : expanded
      const prompt = since ? `${since.modelText}\n\n用户这一轮的消息：\n${message}` : message

      /**
       * `load_skill`（docs/23 §3.3）：判提供集合、是否已加载、本轮次数；通过就记进已加载、发「已加载：…」那一行，
       * 结果带上这个技能的提示段与工具名单，并带 `terminate`（给老镜像：它们靠提前结束这一批再 continue；
       * 现在的 runner 剥掉它，在 prepareNextTurnWithContext 里并进新工具）
       */
      const loadSkill = async (id: string, agent: RunAgent) => {
        const skill = (agent.sub ? agent.sub.offered : offeredSkills).get(id)
        if (!skill) {
          if (agent.sub && id === DELEGATE_SKILL_ID) throw new Error('子 agent 不能派子任务（只有一层）：自己做完，或用 request_confirmation 交回父 agent')
          throw new Error(
            registry.get(id)
              ? `技能 ${id} 这一轮不提供（授权或部署条件不满足），不能加载；用已有的工具完成，或向用户说明`
              : `没有技能 ${id}；能加载的技能见系统提示里的技能目录`,
          )
        }
        const toolNames = skill.tools(skillContext).map((tool) => tool.name)
        if (agent.loadedSkills.has(id)) {
          return {
            content: [{ type: 'text' as const, text: `技能「${skill.title}」已经加载了，这些工具现在就能用：${toolNames.join('、')}` }],
            details: { summary: `技能「${skill.title}」已加载`, elementIds: [] },
          }
        }
        if (agent.skillLoads >= limits.maxSkillLoads) {
          throw new Error(
            `本轮已经加载了 ${agent.skillLoads} 次技能，达到上限 ${limits.maxSkillLoads}，不能再加载；请用已有的工具完成，或向用户说明`,
          )
        }
        agent.skillLoads += 1
        agent.loadedSkills.add(id)
        // 「已加载：…」那一行只给父 agent 的（子 agent 的上下文不进对话，它加载了什么不单独显示）
        if (!agent.sub) {
          const display: AgentSkillLoadedMessage = {
            id: createId('skl'),
            role: 'skill-loaded',
            skill: { id, title: skill.title },
            createdAt: Date.now(),
          }
          liveChanges.push(display)
          send(mapper.skillLoaded(display))
        }
        return {
          content: [{ type: 'text' as const, text: loadedSkillText(skill, toolNames) }],
          details: { summary: `加载技能「${skill.title}」`, elementIds: [], loadedSkill: id },
          terminate: true,
        }
      }
      // 事件里那句话用；真正执行时按调用它的 agent 现造一个（executeTool）
      tools.set(LOAD_SKILL_TOOL_NAME, createLoadSkillTool((id) => loadSkill(id, mainAgent)))

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
        // 哪个 agent 调的：只认服务端分配过、还没结束的（runner 不可信，报来的 id 只用于这一轮内部的区分）
        const agent = agents.get(request.agentId ?? MAIN_AGENT_ID)
        if (!agent || agent.finished) {
          return { isError: true, message: '这个子任务已经结束（或不存在），这次调用没有执行' }
        }
        if (agent.exhausted) {
          return { isError: true, message: `子任务的步数已达上限 ${limits.maxTurns}，这次调用没有执行；直接给出最终回复` }
        }
        // load_skill 按调用它的 agent 现造：各 agent 的已加载集合、加载次数各算
        const tool =
          request.name === LOAD_SKILL_TOOL_NAME ? createLoadSkillTool((id) => loadSkill(id, agent)) : tools.get(request.name)
        // 不是这一轮提供的工具，或在 runner 里执行的：网关不代它执行
        if (!tool || tool.execution === 'runner') return { isError: true, message: `Tool ${request.name} not found` }
        // 这个 agent 没加载的技能里的工具（runner 不可信，可能直接点名）：拒绝。和能力判权是两道独立的检查（docs/23 §3.3）
        const owner = registry.skillOfTool(tool.name)
        if (owner && !agent.loadedSkills.has(owner.id)) {
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
            arguments: (request.args ?? {}) as JsonObject,
          })
        } catch (err) {
          return { isError: true, message: errorText(err) }
        }
        const key = callKey(agent.id, request.toolCallId)
        const at = Date.now()
        const fail = (message: string): ToolCallResponse => {
          executed.set(key, {
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
        /** 这次调用刚占上的节点：调用没执行成就退掉（什么都没写，不该挂着占用） */
        let claimed: string[] = []
        try {
          // 第一道：能力判权（判失败时 authority 已经把这一轮叫停了，这里把错误回给模型）
          await gate.authorize(tool.capability)
          // 第二道（独立于判权）：写节点 data 的调用过「改过」和「正在改」两道检查，并占用（docs/20 §3.10.8）
          const guard = await guardDataWrites(tool, args, agent)
          if (!guard.ok) return fail(guard.message)
          claimed = guard.claimed
          const readMark = dataSeq
          const result = await tool.execute(request.toolCallId, args as never, runAbort.signal)
          const details = result.details
          const elementIds = Array.isArray(details?.elementIds)
            ? details.elementIds.filter((id): id is string => typeof id === 'string')
            : []
          // 新建的节点执行之后才知道 id：执行后占用（新 id 撞不上别人；登记表出错只记一笔，节点已经建好了）
          const created = createdNodeIds(tool.name, elementIds)
          if (created.length > 0) {
            const taken = await occupy(run, agent.id, created)
            if (taken.ok) claimed = [...claimed, ...taken.claimed]
            else console.warn(`[agent] run=${run.runId} 新建节点没能占用：${taken.message}`)
          }
          if (claimed.length > 0) scheduleRunsChange(flowId)
          if (tool.capability !== 'flow:read') await noteWrite(agent, [...guard.targets, ...created], elementIds)
          // 读类工具：读过的移出这个 agent 的「改过」集合，结果里标出别的 agent 正占用着的节点；readNodeIds 只在服务端用，不交给 runner
          let content = result.content
          let shown = details
          const readIds = Array.isArray(details?.readNodeIds) ? details.readNodeIds : null
          if (readIds && details) {
            for (const nodeId of readIds) {
              const entry = agent.stale.get(nodeId)
              if (entry && entry.seq <= readMark) agent.stale.delete(nodeId)
            }
            const note = await occupancyNote(readIds, agent)
            if (note) content = [...content, { type: 'text', text: note }]
            shown = { ...details }
            delete shown.readNodeIds
          }
          executed.set(key, {
            name: tool.name,
            args: digestArgs(args),
            ok: true,
            elementIds,
            error: null,
            durationMs: Date.now() - at,
            at: Date.now(),
          })
          return { isError: false, content, details: shown, ...(result.terminate ? { terminate: true } : {}) }
        } catch (err) {
          // 工具先校验后动手，抛了就是什么都没写：这次刚占的退掉
          if (claimed.length > 0) await serialized(run, () => releaseNodes(run, claimed))
          return fail(errorText(err))
        }
      }

      /**
       * 一次写调用成功之后（docs/20 §3.10.11）：它写过 data 的节点记进同一轮**别的** agent 的「改过」集合（同一轮的不同 agent 互相算别人），
       * 子 agent 再把它碰过的节点记进「改过的节点」（交回父 agent 时汇总）。
       */
      const noteWrite = async (agent: RunAgent, dataTargets: readonly string[], elementIds: readonly string[]) => {
        if (dataTargets.length > 0) markStale(dataTargets, `${agentLabel(agent)} 改了它的数据`, agent)
        if (!agent.sub) return
        for (const id of dataTargets) agent.changed.add(id)
        if (elementIds.length === 0) return
        try {
          const nodes = await opened.read((doc) => {
            const map = nodesMap(doc)
            return elementIds.filter((id) => map.has(id))
          })
          for (const id of nodes) agent.changed.add(id)
        } catch (err) {
          console.warn(`[agent] run=${run.runId} 汇总子任务改过的节点时读不到画布`, err)
        }
      }

      /**
       * 写节点 data 的两道检查（docs/20 §3.10.8），和能力判权同一层、不进工具实现，按调用它的 agent 判：
       * 1. **改过**：这个 agent 读过之后被别人（含同一轮的别的 agent）改了 data、还没重读 → 拒绝，附上被谁改了什么；
       * 2. **正在改**：逐个占用，有一个被别的 run / 同一轮的别的 agent 占着 → 退掉这次刚占的、拒绝。
       * 不写 data 的调用（连线、布局、只改 metadata、读）两道都不过。
       */
      const guardDataWrites = async (
        tool: CanvasTool,
        args: unknown,
        agent: RunAgent,
      ): Promise<{ ok: true; claimed: string[]; targets: string[] } | { ok: false; message: string }> => {
        const ids = Array.isArray((args as { ids?: unknown } | null)?.ids) ? ((args as { ids: unknown[] }).ids) : []
        // 删除点名的 id 里哪些是节点（连线不占用）：要看文档
        const nodes =
          tool.name === 'delete_elements'
            ? await opened.read((doc) => {
                const map = nodesMap(doc)
                return new Set(ids.filter((id): id is string => typeof id === 'string' && map.has(id)))
              })
            : null
        const targets = dataWriteTargets(
          { name: tool.name, skillId: registry.skillOfTool(tool.name)?.id ?? null, writes: tool.capability !== 'flow:read', args },
          (id) => nodes?.has(id) ?? true,
        )
        if (targets.length === 0) return { ok: true, claimed: [], targets }

        const outdated = targets.filter((id) => agent.stale.has(id))
        if (outdated.length > 0) {
          // 窗口里还攒着的先算出来，摘要才说得出改了什么（经 canvas.read，照样重查权限）
          await activeWatch.flush()
          const lines = outdated.map((id) => {
            const entry = agent.stale.get(id)
            const what = entry && entry.summaries.length > 0 ? entry.summaries.join('；') : `${[...(entry?.actors ?? [])].join('、') || '其他协作者'} 改了它的数据`
            return `节点 ${id} 在你读过之后被改过（${what}）`
          })
          const stopAdvice = agent.sub ? '用 request_confirmation 交回父 agent 确认' : '停下来向用户确认'
          return {
            ok: false,
            message:
              `${lines.join('\n')}\n这次写入没有执行。先重读（get_node；导演台用 get_director_scene）看别人改了什么：` +
              `和你要做的不冲突就接着做；冲突了、或要用的东西被删了，${stopAdvice}。`,
          }
        }
        const taken = await occupy(run, agent.id, targets)
        return taken.ok ? { ...taken, targets } : taken
      }

      /**
       * 读到的节点里有被别人（别的 run，或同一轮的别的 agent）占着的：在结果末尾标一句（docs/20 §3.10.8「读类工具标出占用」）；
       * 登记表读不到就不标
       */
      const occupancyNote = async (readIds: readonly string[], agent: RunAgent): Promise<string | null> => {
        if (readIds.length === 0) return null
        let all: Map<string, NodeLease>
        try {
          // 读几个节点就逐个查；读整张画布（几十上百个）按画布前缀扫一次（多副本下是 SCAN，别为一两个节点扫）
          all =
            readIds.length <= 8
              ? new Map(
                  (await Promise.all(readIds.map(async (id) => [id, await leases.get(flowId, id)] as const))).filter(
                    (pair): pair is readonly [string, NodeLease] => pair[1] !== null,
                  ),
                )
              : await leases.list(flowId)
        } catch (err) {
          console.warn(`[agent] run=${run.runId} 读取占用登记失败，结果里不标占用`, err)
          return null
        }
        const wanted = new Set(readIds)
        const others = [...all].filter(
          ([nodeId, lease]) => wanted.has(nodeId) && (lease.runId !== run.runId || leaseAgentOf(lease) !== agent.id),
        )
        if (others.length === 0) return null
        return (
          `【节点占用】下面这些节点正在被别的助手修改，写它们会被拒绝（读不受影响）：` +
          others.map(([nodeId, lease]) => `${nodeId}（${holderName(lease, run.runId)}）`).join('、') +
          (agent.sub ? '。需要改它们时用 request_confirmation 交回父 agent。' : '。需要改它们时先告诉用户，问要不要等对方结束。')
        )
      }

      // —— 子 agent 的派发与交回（docs/20 §3.10.11）——

      /** 一个子 agent 结束了（交回 / 被收掉）：释放它的占用（不还给父 agent），在跑的数减一，没有在跑的了就恢复单轮计时 */
      const closeSubagent = async (agent: RunAgent) => {
        agent.finished = true
        const released = await releaseAgentNodes(run, agent.id)
        run.activeSubagents = Math.max(0, run.activeSubagents - 1)
        if (run.activeSubagents === 0) resumeClock()
        if (released > 0 || run.listed) scheduleRunsChange(flowId)
      }

      /**
       * `/agent/delegate`：父 agent 的一次 `delegate_task`。只有父 agent 能派（只有一层）；上限（同时 / 累计）、工具调用次数在这里判；
       * 服务端分配 id、展开提及、按节点类型定自动加载的技能、转交占用、开子任务条目。拒绝都是给父 agent 看的工具错误
       */
      const delegateTask = async (request: DelegateRequest): Promise<DelegateResponse> => {
        const refuse = (message: string): DelegateResponse => ({ ok: false, message })
        const caller = agents.get(request.agentId)
        if (!caller || caller.finished) return refuse('这个 agent 不存在或已经结束，没有派出子任务')
        if (caller.sub) return refuse('子 agent 不能再派子任务（只有一层）：自己做完，或用 request_confirmation 交回父 agent')
        if (run.stopped !== null) return refuse('这一轮已经停止，没有派出子任务')
        // 必须对得上父 agent 一次已经开始的 delegate_task（runner 派发前先冲了事件）：子任务条目挂在那一条上
        if (startedCalls.get(callKey(MAIN_AGENT_ID, request.toolCallId))?.name !== AGENT_DELEGATE_TOOL_NAME) {
          return refuse('没有对应的 delegate_task 调用，没有派出子任务')
        }
        if (delegatedCalls.has(request.toolCallId)) return refuse('这次 delegate_task 已经派过子任务了')
        // delegate_task 本身也是一次工具调用：全轮共用的次数
        gatewayToolCalls += 1
        if (gatewayToolCalls > limits.maxToolCalls) {
          return refuse(`本轮工具调用已达上限 ${limits.maxToolCalls} 次，没有派出子任务；请停止并向用户说明进度`)
        }
        if (run.activeSubagents >= limits.maxSubagents) {
          return refuse(`同时最多 ${limits.maxSubagents} 个子任务在跑，这一个没有派出；等前面的做完再派，或自己做`)
        }
        if (delegatedTotal >= limits.maxSubagentsPerRun) {
          return refuse(`这一轮已经派了 ${delegatedTotal} 个子任务，达到上限 ${limits.maxSubagentsPerRun}，不能再派；剩下的自己做，或向用户说明`)
        }
        // 同步占住名额（同一批并行的几个派发之间没有空子可钻），之后出错再退回
        delegatedCalls.add(request.toolCallId)
        delegatedTotal += 1
        run.activeSubagents += 1
        if (run.activeSubagents === 1) pauseClock()
        const id = createId('sub')
        const text = subagentBrief(request.brief, request.nodeIds)
        let types: string[]
        let prompt: string
        try {
          // 展开提及（= 它读过这些节点）、拿节点类型定自动加载的技能：经 canvas.read，照样重查权限
          ;({ types, prompt } = await opened.read((doc) => ({
            types: parseNodeMentions(text).flatMap((nodeId) => {
              const node = readNodeById(doc, nodeId)
              return node ? [node.type] : []
            }),
            prompt: expandMentions(text, (nodeId) => lookupMention(doc, nodeId)),
          })))
        } catch (err) {
          run.activeSubagents -= 1
          if (run.activeSubagents === 0) resumeClock()
          return refuse(`没有派出子任务：${errorText(err)}`)
        }
        const plan = registry.plan({ env, previous: [], mentionedNodeTypes: types, exclude: [DELEGATE_SKILL_ID] })
        // 子 agent 能用的 ⊆ 这一轮提供的（服务端的工具实例只按这一轮提供的造过）
        const subOffered = new Map(plan.offered.filter((skill) => offeredSkills.has(skill.id)).map((skill) => [skill.id, skill]))
        const loaded = plan.loaded.filter((skill) => subOffered.has(skill.id))
        const agent = newRunAgent(id, {
          toolCallId: request.toolCallId,
          brief: request.brief,
          nodeIds: request.nodeIds,
          offered: subOffered,
        })
        for (const skill of loaded) agent.loadedSkills.add(skill.id)
        agents.set(id, agent)
        // 父 agent 正占着的节点，原子地转交给它（比较后写）；它结束时释放，不还给父 agent
        await transferNodes(run, MAIN_AGENT_ID, id, request.nodeIds)
        send(mapper.subtaskStart({ id, toolCallId: request.toolCallId, brief: request.brief, nodeIds: request.nodeIds, startedAt: Date.now() }))
        scheduleRunsChange(flowId)
        console.info(`[agent] run=${run.runId} 派出子任务 ${id}（同时 ${run.activeSubagents} 个，累计 ${delegatedTotal} 个）`)
        return {
          ok: true,
          agent: {
            agentId: id,
            systemPrompt: `${systemPromptFor({
              loaded,
              catalog: plan.catalog.filter((skill) => subOffered.has(skill.id)),
              unavailable: [],
              maxSkillLoads: limits.maxSkillLoads,
            })}\n\n${SUBAGENT_PROMPT}`,
            prompt,
            skills: { loaded: loaded.map((skill) => skill.id) },
            limits: { maxTurns: limits.maxTurns },
          },
        }
      }

      /** `/agent/finish`：一个子 agent 交回。状态由服务端改判（步数用完 / 这一轮已停 = 失败），结果限长 */
      const finishSubagent = async (request: SubagentFinishRequest): Promise<SubagentFinishResponse> => {
        const agent = agents.get(request.agentId)
        if (!agent?.sub || agent.finished) {
          return { isError: true, text: '没有这个子任务，或它已经交回过了', summary: '子任务', changedNodeIds: [] }
        }
        let { status, error } = request
        if (run.stopped !== null) {
          status = 'failed'
          error = run.stopped.reason
        } else if (agent.exhausted && status !== 'failed') {
          status = 'failed'
          error = `超过子任务的步数上限 ${limits.maxTurns}`
        }
        await closeSubagent(agent)
        const changed = [...agent.changed]
        const question = status === 'needs_confirmation' ? (request.question ?? '') : null
        send(
          mapper.subtaskFinish(agent.id, {
            status,
            text: clipText(request.text.trim(), SUBTASK_TEXT_LIMIT),
            question,
            error: status === 'failed' ? (error ?? '子任务失败') : null,
            changedNodeIds: changed,
          }),
        )
        return {
          isError: status === 'failed',
          text: subagentResultText({
            brief: agent.sub.brief,
            status,
            text: request.text,
            question,
            error,
            changed,
            maxChars: limits.subagentReplyChars,
          }),
          summary: `子任务${SUBTASK_STATUS_LABEL[status]}：${clipText(agent.sub.brief.replace(/\s+/g, ' '), 40)}`,
          changedNodeIds: changed,
        }
      }

      /** 父 agent 已经不等了（它进了下一步），子任务却没交回：不可能出自守规矩的 runner —— 服务端把它们收掉、标成失败 */
      const abandonSubagents = (out: AgentStreamEvent[]) => {
        for (const agent of agents.values()) {
          if (!agent.sub || agent.finished) continue
          console.warn(`[agent] run=${run.runId} 子任务 ${agent.id} 没有交回，父 agent 就进入了下一步：按失败收掉`)
          void closeSubagent(agent)
          out.push(
            ...mapper.subtaskFinish(agent.id, {
              status: 'failed',
              text: mapper.subtask(agent.id)?.text ?? '',
              error: '子任务没有交回结果',
              changedNodeIds: [...agent.changed],
            }),
          )
        }
      }

      /**
       * 一批调过工具之后、下一次请求模型之前（runner 在 pi 的 `prepareNextTurnWithContext` 里来取）：把窗口里攒着的先合并，
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
      const deliverSteered = (id: string, out: AgentStreamEvent[]) => {
        const entry = steered.get(id)
        if (!entry) return
        steered.delete(id)
        liveChanges.push(entry.display)
        out.push(...mapper.canvasChange(entry.display))
      }

      /**
       * 工具结束时写一行工具调用日志：画布工具以网关的执行记录为准，runner 里执行的（媒体工具、delegate_task）按 runner 报的。
       * 子 agent 的同样记（同一轮的审计）；它的 request_confirmation 不记（不是工具，是交回的方式）
       */
      const logToolCall = (event: Extract<RunnerEvent, { type: 'tool_execution_end' }>, agent: RunAgent) => {
        const key = callKey(agent.id, event.toolCallId)
        const begun = startedCalls.get(key)
        startedCalls.delete(key)
        if (event.toolName === REQUEST_CONFIRMATION_TOOL_NAME) return
        const done = executed.get(key)
        if (done) {
          executed.delete(key)
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
        const calls = agent.sub ? (mapper.subtask(agent.id)?.toolCalls ?? []) : mapper.message.toolCalls
        const view = calls.find((call) => call.id === event.toolCallId)
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

      /**
       * runner 上报的一批事件：按顺序映射，映射出的全部帧**作为一批**发出去（共享补发日志里一条记录，文字增量不逐帧写；
       * 批内同步，网关保证批与批不并发）
       */
      const onEvents = (events: RunnerEvent[]) => {
        const batch: AgentStreamEvent[] = []
        for (const event of events) {
          // 叫停之后（比如这一批里的 turn_end 刚撞上步数上限）的事件不再收
          if (run.stopped !== null) break
          // 归到哪个 agent：服务端分配过、还没结束的才认（runner 不可信：认不出的子 agent 事件丢掉）
          const agent = agents.get(event.agentId ?? MAIN_AGENT_ID)
          if (!agent || agent.finished) continue
          if (event.type === 'tool_execution_start') {
            startedCalls.set(callKey(agent.id, event.toolCallId), { name: event.toolName, args: event.args, at: Date.now() })
          }
          if (agent.sub) {
            // 子 agent：步数各算；它的事件只改它的子任务条目，不进父 agent 的上下文和 assistant 消息
            if (event.type === 'turn_end') {
              agent.turns += 1
              // 到了上限还要接着调工具（这一步调过工具）= 步数用完；最后一步正好是不调工具的回复不算
              if (agent.turns >= limits.maxTurns && event.toolResultCount > 0) agent.exhausted = true
              // runner 到了上限就结束它的循环（finishTurn，不再请求模型）；多一步算宽限（老镜像停它时还会报一次 turn_end），再多就是 runner 不守规矩：整轮停
              if (agent.turns > limits.maxTurns + 1) stopRun(run, `子任务 ${agent.id} 超过步数上限 ${limits.maxTurns}，已停止`)
            }
            batch.push(...mapper.subtaskEvent(agent.id, event))
            if (event.type === 'tool_execution_end') logToolCall(event, agent)
            continue
          }
          if (event.type === 'turn_end') {
            agent.turns += 1
            if (agent.turns >= limits.maxTurns) stopRun(run, `超过本轮步数上限 ${limits.maxTurns}，已停止`)
            // 父 agent 进了下一步：它不再在 delegate_task 里等，还没交回的子任务不会再有人等了
            if (run.activeSubagents > 0) abandonSubagents(batch)
          }
          if (event.type === 'message_end') appended.push(event.message)
          const mapped = mapper.handle(event)
          if (event.type === 'tool_execution_end') logToolCall(event, agent)
          batch.push(...mapped)
          if (event.type === 'message_end' && event.steerId) deliverSteered(event.steerId, batch)
        }
        send(batch)
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
          delegate: delegateTask,
          agentFinish: finishSubagent,
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
      // 空闲上限：runner 来过之后（兑换过 bootstrap），既没有在途请求、又连续 idleTimeoutMs 没有新请求 → 停下
      idleWatch = setInterval(
        () => {
          const { inflight, lastActivityAt } = registration.activity()
          if (lastActivityAt === null || inflight > 0) return
          if (Date.now() - lastActivityAt >= limits.idleTimeoutMs) {
            stopRun(run, `agent 运行环境已经 ${Math.round(limits.idleTimeoutMs / 1000)} 秒没有任何请求（可能卡住或断网），按空闲超时停止`)
          }
        },
        Math.max(20, Math.min(5000, Math.floor(limits.idleTimeoutMs / 4))),
      )
      idleWatch.unref?.()

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
      // 跨轮的上下文按条数、也按 token 裁（余量规则见 llmHistoryTokenBudget）：固定部分 = 这一轮的系统提示 + 提供的全部工具定义
      const fixedTokens =
        estimateTextTokens(runnerInput.systemPrompt) +
        estimateTextTokens(JSON.stringify([...tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))))
      nextLlm = trimLlmHistory([...llmHistory, ...received], limits.llmMessages, llmHistoryTokenBudget(resolved.model, fixedTokens))
      // 两者都在回调里赋值，TS 的收窄看不见：显式放宽
      const finishReport = runnerFinish as FinishRequest | null
      const exitInfo = sandboxExit as SandboxExit | null
      const mismatch = protocolMismatch as { runnerVersion: number | null; serverVersion: number } | null
      const last = received.at(-1)
      // 模型报「上下文超长」：单独一个 code，原因说人话（原文接在后面）
      const overflow = mapper.modelError ? contextOverflowError(received, resolved.model, mapper.modelError) : null
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
                  ? overflow
                    ? { type: 'error', message: overflow, code: 'context_overflow' }
                    : { type: 'error', message: mapper.modelError, code: 'model_error' }
                  : { type: 'success' }
    } catch (err) {
      // 签发失败（发起时就已失权）、打开画布失败（画布已删 / 配额锁定）、沙箱起不来……这一轮直接失败
      outcome = run.stopped
        ? stoppedOutcome(run.stopped)
        : { type: 'error', message: errorText(err), code: 'run_failed' }
      if (handle && !sandboxExit) await handle.kill('这一轮出错，收尾')
    } finally {
      clearTimeout(timer)
      clearTimeout(totalTimer)
      clearTimeout(exitGrace)
      clearInterval(idleWatch)
      // 无论怎么结束：令牌作废、在途请求掐断
      gatewayRun?.close()
      runAbort.abort()
    }
    // 不会再有写入了（令牌已作废）：释放全部占用（成功 / 中止 / 出错 / 超时 / 服务退出都走这里），节点上的标签随之消失
    if ((await releaseAll(run)) && run.listed) scheduleRunsChange(flowId)
    // 网关执行了、但 runner 没来得及报结束的工具调用（被杀在半路）：照样记进审计
    for (const [key, call] of executed) recordExecuted(key.slice(key.indexOf('\n') + 1), call)
    // 没交回的子任务（这一轮被停 / 出错）：在跑的数归零（占用已随 releaseAll 释放；条目由 mapper.finish 标成失败）
    run.activeSubagents = 0
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
      // 父 agent 的 + 全部子 agent 的
      toolCallCount:
        mapper.message.toolCalls.length + (mapper.message.subtasks ?? []).reduce((sum, task) => sum + task.toolCalls.length, 0),
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

  /**
   * 跨副本接回（docs/20 §3.10.10）：这一轮不在本副本 —— 查共享登记（不在 = 404），从头读补发日志（断号 / 溢出 = 410），
   * 补发完再阻塞读后续的，直到收尾帧、断号、或这一轮的登记没了（持有副本崩溃）。
   */
  async function subscribeShared(
    flowId: string,
    runId: string,
    onEvent: (event: AgentStreamEvent) => void,
  ): Promise<SubscribeResult> {
    let entries: ReplayEntry[]
    try {
      if (!(await runRegistry.getRun(flowId, runId))) return { ok: false, reason: 'not-found' }
      entries = await runRegistry.readReplay(runId, null)
    } catch (err) {
      console.warn(`[agent] run=${runId} 读不到共享登记 / 补发日志，按接不回处理`, err)
      return { ok: false, reason: 'not-found' }
    }
    // 补发必须从第一批起连续、且没有溢出标记：否则接不回完整序列（和本副本的 410 同一个口径）
    for (const [index, entry] of entries.entries()) {
      if (entry.record.seq !== index + 1 || entry.record.overflow) return { ok: false, reason: 'overflowed' }
    }

    const { subscriber, done } = subscriberOf(onEvent)
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      subscriber.complete()
    }
    let cursor: string | null = null
    let expected = 1
    /** 交出一批读到的；断号（中间丢了，比如溢出后裁剪、写失败）或收尾帧 → 结束 */
    const take = (batch: ReplayEntry[]) => {
      for (const entry of batch) {
        if (ended) return
        if (entry.record.seq !== expected) {
          console.warn(`[agent] run=${runId} 跨副本接回的补发断号（要 ${expected}，读到 ${entry.record.seq}），关流`)
          end()
          return
        }
        expected += 1
        cursor = entry.cursor
        for (const event of entry.record.events) {
          deliver(subscriber, event)
          if (isTerminal(event)) {
            end()
            return
          }
        }
      }
    }
    take(entries)
    if (ended) return { ok: true, done, unsubscribe: () => {} }

    // 等后续：每等满一段没有新帧就查一次登记，登记没了（持有副本崩溃 / 已收尾）就把最后的读完、关流
    const blockMs = Math.max(50, Math.min(5000, Math.floor(runRegistry.ttlMs / 3)))
    void (async () => {
      while (!ended) {
        let batch: ReplayEntry[]
        try {
          batch = await runRegistry.waitReplay(runId, cursor, blockMs)
        } catch (err) {
          console.warn(`[agent] run=${runId} 跨副本接回读补发日志失败，稍后再试`, err)
          await sleep(Math.min(blockMs, 1000))
          continue
        }
        if (ended) return
        if (batch.length > 0) {
          take(batch)
          continue
        }
        let alive = true
        try {
          alive = (await runRegistry.getRun(flowId, runId)) !== null
        } catch {
          // 读不到登记：当它还在，下一轮再看
        }
        if (alive || ended) continue
        // 收尾帧可能正好在这两步之间写进去
        take(await runRegistry.readReplay(runId, cursor).catch(() => []))
        end()
      }
    })()
    return { ok: true, done, unsubscribe: end }
  }

  // 别的副本转来的停止指令（docs/20 §3.10.10「停止」）：权限在收到请求的副本上判过，这里只认「是不是我手上的这一轮」
  runRegistry
    .onStop((command: StopCommand) => {
      const run = runs.get(command.runId)
      if (!run || run.flowId !== command.flowId) return
      console.info(`[agent] run=${run.runId} 收到别的副本转来的停止指令（${command.reason}）`)
      stopRun(run, command.reason)
    })
    .catch((err: unknown) => console.error('[agent] 订阅停止指令失败：别的副本停不了本副本上的轮次', err))

  return {
    enabled: resolved !== null,
    modelLabel: resolved?.label ?? null,
    disabledReason: resolved ? null : disabledReason,
    gateway: { handle: (request) => gateway.handle(request) },

    async view(flowId, userId) {
      // 先取一份快照：下面的 await 期间列表可能变化，但这次回复要自洽
      const entries = withMine(await activeRuns(flowId), userId)
      // 我有任务在跑：面板默认打开最近发起的那一轮所在的会话（它也可能刚被删掉 —— 退回最近的那个）
      const own = entries.filter((entry) => entry.mine).at(-1) ?? null

      const running = own ? await store.get(flowId, own.conversationId) : null
      const latest = running && running.userId === userId ? running : await store.latest(flowId, userId)

      return {
        enabled: resolved !== null,
        running: entries.length > 0,
        activeRuns: entries,
        // 前端拿它把 expiresAt 换算成本机时间
        now: Date.now(),
        latest: latest ? await viewOf(latest, userId) : null,
      }
    },

    activeRuns,

    async listConversations(flowId, userId) {
      const rows = await store.list(flowId)
      const [owners, busy] = await Promise.all([profiles(rows.map((row) => row.userId)), busyIn(flowId)])
      return rows.map((row) => summaryOf(row, userId, owners, busy.has(row.id)))
    },

    async getConversation(flowId, userId, id) {
      const row = await store.get(flowId, id)
      return row ? viewOf(row, userId) : null
    },

    async deleteConversation(flowId, userId, id) {
      const row = await store.get(flowId, id)
      if (!row) return 'not-found'
      if (row.userId !== userId) return 'forbidden'
      // 正在跑的那个会话不能删（不论跑在哪个副本上）：结尾那次 save 会扑空，这一轮的对话就凭空没了。
      // 共享槽位读不到就抛（500）—— 宁可这次删不成，也不删掉别的副本上正在跑的会话
      if (await conversationRunning(flowId, id)) return 'running'
      return (await store.remove(flowId, userId, id)) ? 'deleted' : 'not-found'
    },

    isRunning: (flowId) => [...runs.values()].some((run) => run.flowId === flowId),

    async start(input) {
      if (!resolved) {
        return { ok: false, reason: 'disabled', message: disabledReason }
      }
      const busy = { ok: false as const, reason: 'busy' as const, message: '这个会话已经有一轮 agent 正在运行，请等它结束或先停止它' }
      // 同步占位：从这里到 claimConversation 之间没有 await，同一个会话的第二个发起者不可能插进来
      if (input.conversationId !== null && runningHere(input.flowId, input.conversationId)) return busy

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
        held: new Map(),
        claiming: Promise.resolve(),
        heartbeatAt: Date.now(),
        heartbeat: null,
        slot: null,
        record: null,
        recordAttempt: null,
        registryChain: Promise.resolve(),
        replaySeq: 0,
        replayLog: Promise.resolve(),
        replayWriteFailed: false,
        activeSubagents: 0,
      }
      runs.set(run.runId, run)
      if (input.conversationId !== null) {
        claimConversation(run, input.conversationId)
        // 跨副本：共享槽位是原子的「不存在才写」，两个副本同时发起只有一个占得到
        let refused: StartRunResult | null = null
        try {
          if (!(await claimSlot(run, input.conversationId))) refused = busy
        } catch (err) {
          console.error(`[agent] flow=${input.flowId} conversation=${input.conversationId} 共享登记不可用，这一轮不开始`, err)
          refused = { ok: false, reason: 'unavailable', message: '暂时无法确认这个会话是否已有一轮在运行，请稍后再试' }
        }
        if (refused) {
          runs.delete(run.runId)
          releaseConversation(run)
          return refused
        }
      }
      // 从这里起每 1/3 TTL 续期：会话槽位（准备会话那段也要续）、补发日志，进列表后还有登记与占用
      startHeartbeat(run)

      run.done = execute(input, run)
        .catch((err: unknown) => console.error(`[agent] run=${run.runId} 异常`, err))
        // 异常退出（没走到 execute 里那次释放）也不留占用
        .then(async () => {
          await releaseAll(run)
        })
        .then(async () => {
          // 没走到最后一帧就异常退出了：补一帧收尾，订阅者才知道这一轮完了
          if (!run.finished) {
            emitBatch(run, [
              {
                type: AgentEventType.RUN_ERROR,
                message: '这一轮异常结束',
                code: 'run_failed',
                timestamp: Date.now(),
              },
            ])
          }
          // 收尾帧先写进共享补发日志，再删登记：别的副本上跟着的人一定读得到它
          await run.replayLog
          // 删掉条目 = 释放补发缓冲与会话槽位；之后再来接回的一律 not-found（共享日志再留一个 TTL 给还在读的人）
          if (run.owner) rememberOwner(run.runId, run.owner.name)
          runs.delete(run.runId)
          releaseConversation(run)
          await releaseShared(run)
          if (run.listed) await notifyRunsChange(run.flowId)
        })
        .catch((err: unknown) => console.error(`[agent] run=${run.runId} 收尾异常`, err))

      return {
        ok: true,
        runId: run.runId,
        done: run.done,
        unsubscribe: () => {
          if (run.subscribers.delete(initiator.subscriber)) initiator.subscriber.complete()
        },
      }
    },

    async subscribe(flowId, runId, onEvent) {
      const run = runs.get(runId)
      // 不在本副本：去共享登记找（别的副本上的，或刚收尾、本副本已经删掉的）
      if (!run) return subscribeShared(flowId, runId, onEvent)
      if (run.flowId !== flowId) return { ok: false, reason: 'not-found' }
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

    async abort(flowId, runId, actor) {
      const run = runs.get(runId)
      if (run) {
        if (run.flowId !== flowId) return 'not-running'
        if (run.userId !== actor.userId && !actor.admin) return 'forbidden'
        stopRun(run, run.userId === actor.userId ? '已中止' : '已被项目管理员中止')
        return 'aborted'
      }
      // 别的副本上的：权限在这里判（发起人 / 项目管理员），再把停止指令发给持有副本
      const record = await runRegistry.getRun(flowId, runId)
      // 登记没了 = 这一轮已经不在了；登记说在本副本、内存里却没有 = 刚收尾，登记还没删完
      if (!record || record.instanceId === runRegistry.instanceId) return 'not-running'
      const own = record.owner.id === actor.userId
      if (!own && !actor.admin) return 'forbidden'
      await runRegistry.sendStop(record.instanceId, { flowId, runId, reason: own ? '已中止' : '已被项目管理员中止' })
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
