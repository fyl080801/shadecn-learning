import { apiFetch } from "@/lib/auth"
import type {
  AgentPatch,
  GameState,
  ConfigPatch,
  ConfigWriteResult,
  ConnectionPatch,
  LintIssue,
  LintLevel,
  ModelConfig,
  PipelineEvent,
  PresetPatch,
  Quota,
  RunEvent,
  SaveLine,
  SaveSummary,
  ThreadMessage,
  TurnAccepted,
  StoryCheck,
  StoryDetail,
  StoryFile,
  StorySummary
} from "@/types/galstory"

/**
 * GalStory 引擎（`gal-story serve`）的接口封装。
 *
 * **浏览器不直连引擎**：请求打到本应用的 `/api/galstory/*`，由 Node 反代过去
 * （`server/routes/galstory.ts`）。理由有三 —— 引擎那一侧没有任何鉴权且缺省只听 127.0.0.1、
 * 本项目一贯是一个进程一个端口、地址是环境变量因此不进前端 bundle。
 *
 * 与 `src/lib/api.ts` 同一条纪律：只做「发请求 + 解析 + 把非 2xx 变成异常」，业务判断留给调用方。
 * 但**错误信息不自己编**：引擎的 404/409 都带着说人话的 `detail`（「这一局还没装配——先 POST …」），
 * 反代原样透传，这里也原样用 —— 换成一句「请求失败（409）」就等于把它写好的那句话扔了。
 */

/** 反代前缀。引擎那一侧的 `/api` 由反代补，故这里的路径是它 `/api` 之后的部分 */
const BASE = "/api/galstory"

export class GalStoryError extends Error {
  readonly status: number
  /** 引擎 / 反代给的补充说明（例如「确认 gal-story serve 起着」）；没有就是空 */
  readonly hint: string
  /**
   * 引擎给的机读错误码（目前只有配额那条 `too_many_runs`）。空 = 没给。
   *
   * ⚠️ **按它分流，别去匹配文案**：那句中文是给人读的，改一个字就把分支改没了。
   */
  readonly code: string
  /** 那条错误自带的结构化载荷（`too_many_runs` 时是 `running: [...]`）。没有就是 null */
  readonly payload: Record<string, unknown> | null

  constructor(
    message: string,
    status: number,
    hint = "",
    code = "",
    payload: Record<string, unknown> | null = null
  ) {
    super(message)
    this.name = "GalStoryError"
    this.status = status
    this.hint = hint
    this.code = code
    this.payload = payload
  }
}

/**
 * 从引擎的错误响应里抠出人话、错误码与载荷。
 *
 * ⚠️ **`detail` 不一定是字符串**：FastAPI 的 `HTTPException(429, {...})` 会把整个 dict 塞进
 * `detail`，于是配额那条错误的 `detail` 是个**对象** —— 直接 `?? ` 出去，界面上就是一句
 * `[object Object]`，而它本来带着「哪几局在跑、跑了多久」这些正好要显示的信息。
 */
function explain(body: unknown, status: number) {
  const payload = body as { detail?: unknown; error?: string; hint?: string } | null
  const detail = payload?.detail
  if (detail && typeof detail === "object") {
    const inner = detail as Record<string, unknown>
    return {
      message: String(inner.detail ?? inner.message ?? `请求失败（${status}）`),
      hint: String(payload?.hint ?? ""),
      code: String(inner.code ?? ""),
      payload: inner
    }
  }
  return {
    message: String(detail ?? payload?.error ?? `请求失败（${status}）`),
    hint: String(payload?.hint ?? ""),
    code: "",
    payload: null
  }
}

/** 没配 `GAL_STORY_API_URL` —— 是「没开这块功能」，不是「坏了」，两者的下一步动作完全不同 */
export const NOT_CONFIGURED = 503

/**
 * 写请求的形状。**body 省略 = 不带请求体**（`DELETE` 那几条就是这样）。
 *
 * ⚠️ 请求体里**省略一个字段与显式给 null 是两回事**（见 `types/galstory.ts` 写回那一节）：
 * `JSON.stringify` 会把 `undefined` 的键整个丢掉，那正好就是「不动这一项」；要清空一项
 * 就显式写 `null`。故构造 patch 时**别用 `?? null` 去填空**，那会把「没改」变成「清空」。
 */
type WriteInit = { method: "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown }

async function request<T>(path: string, init?: WriteInit): Promise<T> {
  const res = await apiFetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(init?.body === undefined ? {} : { "content-type": "application/json" })
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body)
  })
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const info = explain(body, res.status)
    throw new GalStoryError(info.message, res.status, info.hint, info.code, info.payload)
  }
  return body as T
}

// ── 故事 ────────────────────────────────────────────────────────────────────

export const storyApi = {
  /**
   * 故事选单。**它只有那么几个字段**，不是接口没做完 —— 引擎刻意不在这条口上给
   * `core_conflict`/`ending`/开场白（见 `types/galstory.ts` 模块头第 2 条）。
   *
   * `scope` 是**过滤器**，不是第二条路由：「我能玩哪些故事」只有这一个口——同一个问题
   * 两个答案正是这两个仓库反复栽过的形态。缺省 `all` = 我的（在前）+ 公共。
   *
   * ⚠️ **「只有我看得到我的故事」不靠这个参数**：属主隔离在服务端那一层就成立了
   * （每条转发带 `X-Gal-Owner`，引擎按属主分目录），`scope=public` 只是让人分栏看。
   */
  list(scope: "all" | "public" | "mine" = "all"): Promise<StorySummary[]> {
    return request<StorySummary[]>(`/stories?scope=${scope}`)
  },

  /**
   * 作者面详情：角色、编制、知识计数、节拍旋钮、作者态体检。
   *
   * ⚠️ **多用户部署下它只对「我的」故事开**（引擎那侧判据在部署形态上：打开了属主信任
   * 就收紧）——公共故事的 `goal`/`endWhen`/私有条目数对玩家全是剧透。故这条口对公共故事
   * 拿到 404 是**正常**的，不是加载失败，调用方要据 `status === 404` 降级。
   */
  get(name: string): Promise<StoryDetail> {
    return request<StoryDetail>(`/stories/${encodeURIComponent(name)}`)
  },

  /**
   * 新建**我的**故事：不给 `fromStory` 就是一份能直接跑的最小骨架，给了就是从那个故事整份复制。
   *
   * ⚠️ **「复制成我的」与「开始玩一局」是两个动作**：那个产出**存档**（`saveApi.create`），
   * 这个产出**模板**。合成一个入口之后「我想改改这个故事」就没地方去了。
   */
  create(title: string, fromStory = ""): Promise<StorySummary> {
    return request<StorySummary>("/stories", {
      method: "POST",
      body: fromStory ? { title, fromStory } : { title }
    })
  },

  /**
   * 改标题。引擎那边走 **round-trip 就地改这一个键** —— 一份从公共故事复制来的 `story.yaml`
   * 带着几十行注释，整份 dump 回去就全没了，而**抹掉之后没有任何东西会失败**。
   */
  rename(name: string, title: string): Promise<StorySummary> {
    return request<StorySummary>(`/stories/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: { title }
    })
  },

  /**
   * **问一句**「删掉它会怎么样」：发一发**不带 confirm** 的删除，把引擎拒绝时那句话拿回来
   * （里面有「基于它的存档有几个」）。
   *
   * ⚠️ **那个数要引擎来说，前端不自己拼**：选单里的 `saves` 是另一时刻的计数，界面自己
   * 拼一句就是同一个事实两处声明。返回值就是那句话；引擎哪天不再要求确认（真删了）则返回空串
   * ——调用方据此知道**已经删掉了**。
   */
  async confirmHint(name: string): Promise<string> {
    try {
      await request<void>(`/stories/${encodeURIComponent(name)}`, { method: "DELETE" })
      return ""
    } catch (err) {
      if (err instanceof GalStoryError && err.status === 400) return err.message
      throw err
    }
  },

  /**
   * 真删掉我的一个故事。
   *
   * ⚠️ **不级联删存档**：存档自带整份模板副本，删了模板照样续得下去，只是列表里点不到
   * 「再开一局」——那也是引擎那侧刻意的（`SaveEntry.story` 从此指不到任何模板**是对的**，
   * 它记的是「当初从哪儿来的」这个历史事实）。
   */
  remove(name: string): Promise<void> {
    return request<void>(`/stories/${encodeURIComponent(name)}?confirm=true`, { method: "DELETE" })
  },

  /**
   * 这个故事现在跑不跑得起来（零 LLM、零成本，公共故事也能问）。
   *
   * ⚠️ `blockers` 与 `issues` 是两件事，别在界面上合成一列（见 `types` 里那条）。
   */
  check(name: string): Promise<StoryCheck> {
    return request<StoryCheck>(`/stories/${encodeURIComponent(name)}/check`)
  },

  /** 这个故事里**可编辑**的文件（相对路径）。公共故事也能列——看得见不等于改得了 */
  files(name: string): Promise<string[]> {
    return request<string[]>(`/stories/${encodeURIComponent(name)}/files`)
  },

  /** 读一个文件的原文 */
  readFile(name: string, path: string): Promise<StoryFile> {
    return request<StoryFile>(`/stories/${encodeURIComponent(name)}/files/${encodePath(path)}`)
  },

  /**
   * 写一个文件。引擎那边**先在临时副本上把整个故事装载一遍，通过了才换入**。
   *
   * 两档失败，**按状态码分流**：
   * - **403** = 这条路径不可写（`plugins/`、`skills/` 里是会被 exec 的代码，只能随
   *   「复制一个现成故事」带进来）——那是能力边界，说清楚就行；
   * - **422** = 改完之后这个故事跑不起来，`GalStoryError.payload.check` 里带着 blockers，
   *   **原文件一个字节没动**。要把那几条逐条显示给作者，而不是一句「保存失败」。
   */
  writeFile(name: string, path: string, text: string): Promise<StoryCheck> {
    return request<StoryCheck>(`/stories/${encodeURIComponent(name)}/files/${encodePath(path)}`, {
      method: "PUT",
      body: { text }
    })
  },

  /** 删一个文件（判据与写入逐字相同：先验后删） */
  deleteFile(name: string, path: string): Promise<StoryCheck> {
    return request<StoryCheck>(`/stories/${encodeURIComponent(name)}/files/${encodePath(path)}`, {
      method: "DELETE"
    })
  }
}

/**
 * 相对路径进 URL。**逐段编码、保住 `/`**：`characters/npc.yaml` 是引擎那条口的一个
 * `{path:path}` 参数，整串 `encodeURIComponent` 会把分隔符变成 `%2F` —— 那样路由根本匹配不上。
 */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/")
}

// ── 存档 ────────────────────────────────────────────────────────────────────

export const saveApi = {
  /** 不传 story 就是全部存档（引擎的存档索引本来就跨故事） */
  list(story?: string): Promise<SaveSummary[]> {
    const query = story ? `?story=${encodeURIComponent(story)}` : ""
    return request<SaveSummary[]>(`/saves${query}`)
  },

  /**
   * 这个存档有哪些故事线。
   *
   * ⚠️ **单场景故事没有存档点，引擎会 409**（那不是错误，是「这个故事没有回退这回事」）。
   * 调用方据 `GalStoryError.status === 409` 降级，别当成加载失败。
   */
  lines(saveId: string): Promise<SaveLine[]> {
    return request<SaveLine[]>(`/saves/${encodeURIComponent(saveId)}/lines`)
  },

  /**
   * 新建一个存档（= 开一局新的）。**此刻还没花钱**：模板整份复制进存档目录，仅此而已；
   * 建档那几十次模型调用发生在下面的 `open`。
   */
  create(story: string, title = ""): Promise<SaveSummary> {
    return request<SaveSummary>("/saves", { method: "POST", body: { story, title } })
  },

  /**
   * 装配这一局。
   *
   * ⚠️⚠️ **对局界面刻意不用它，你多半也不该用**。首次调用会跑建档（归一化 + 公开人物志 +
   * 按 observer 分调的初次印象 + 泄密判定，几十次模型调用），**几分钟起步**，而它是一次
   * **阻塞的 HTTP 请求** —— 链路上任何一层的超时都会把它掐掉（实测踩过，界面上还显示成
   * 「连不上后端」），而且那几分钟里前端一个字都收不到。
   *
   * 正确的做法：`GET /state` 探一下（没装配会 409），装配交给第一轮 `playTurn` ——
   * 那条 202 立刻返回，worker 自己装配，建档的每一次调用都从事件流上走出来。
   * 见 `useGalStoryRun.probe`。
   *
   * 留着它是因为它确实对应引擎的一条口（脚本/调试会用），不是给对局界面用的。
   */
  open(saveId: string): Promise<GameState> {
    return request<GameState>(`/saves/${encodeURIComponent(saveId)}/open`, { method: "POST" })
  },

  /**
   * 这一局此刻的状态。⚠️ **没装配过会 409 并指路**（让你去 `open`）——那不是错误，
   * 是引擎拒绝替调用方决定花那笔钱。调用方据 `status === 409` 分流。
   */
  state(saveId: string): Promise<GameState> {
    return request<GameState>(`/saves/${encodeURIComponent(saveId)}/state`)
  },

  /**
   * 这条线程的聊天历史（从落盘实录现读现翻）。缺省只给**当前这一场**——整局实录一轮可达
   * 数 KB，补个历史不该动辄整局解析；要整局就 `whole = true`。
   *
   * ⚠️ **续玩时必须调它**：`GameState.lastNarrative` 只有**最后一段**，拿它当历史的话，
   * 点「继续」进来就只看得到一段。事件流那条 `MESSAGES_SNAPSHOT` 也补历史，但它只在
   * 开一次 run 且客户端没带消息时才发 —— 中途续玩的存档根本不会触发。
   */
  messages(saveId: string, whole = false): Promise<ThreadMessage[]> {
    const query = whole ? "?whole=true" : ""
    return request<ThreadMessage[]>(`/saves/${encodeURIComponent(saveId)}/messages${query}`)
  },

  /**
   * 这一局的 **agent 执行轨迹**（每次模型调用一条）。
   *
   * ⚠️ **刷新页面之后把执行过程显示回去，靠的就是它**：进度事件只活在引擎内存里，而实录
   * `TurnRecord` 里没有每次调用的耗时/token/尝试次数/所属阶段 —— 那是单独存的一份。
   *
   * 给出来的与当时**推流的那一份逐字相同**（不含角色真名、提示词与产出原文）。
   */
  trace(saveId: string, fromTurn = 0): Promise<PipelineEvent[]> {
    const query = fromTurn ? `?from_turn=${fromTurn}` : ""
    return request<PipelineEvent[]>(`/saves/${encodeURIComponent(saveId)}/trace${query}`)
  },

  /** 删掉一个存档（连同几十轮的实录、知识库与关系日志）。引擎要求显式确认 */
  remove(saveId: string): Promise<void> {
    return request<void>(`/saves/${encodeURIComponent(saveId)}?confirm=true`, { method: "DELETE" })
  },

  /**
   * 演一轮：**立刻回 202**，产物落盘、进度走事件流（`follow`）。
   *
   * ⚠️ **已经在跑时这条消息不会被吃掉**（`accepted: false` / `consumedInput: false`），
   * 它附着到那一轮上。此前 AG-UI 那侧踩过的坑就是这个：客户端重发时带着同一条消息，
   * 于是同一个意图演了两遍。界面上据 `consumedInput` 决定要不要把输入框清空。
   */
  playTurn(saveId: string, text: string): Promise<TurnAccepted> {
    return request<TurnAccepted>(`/saves/${encodeURIComponent(saveId)}/turns`, {
      method: "POST",
      body: { text },
    })
  }
}

// ── 在跑的回合 ──────────────────────────────────────────────────────────────

export const runApi = {
  /**
   * **我此刻在跑哪几轮** + 并发上限。只读、零成本，故事列表按它显示「进行中」。
   *
   * ⚠️ **别拿 `SaveSummary.open` 当「在跑」**：那个说的是「装配过、还在引擎内存里」，
   * 一局玩完放在那儿也是 true —— 拿它当进行中，界面上每一局都会显示成在跑。
   *
   * ⚠️ **`limit` 用引擎给的这个，别在前端写死**：它是部署配置
   * （`GAL_SERVER_MAX_CONCURRENT_RUNS`），写死就是同一个判据两处声明。
   */
  list(): Promise<Quota> {
    return request<Quota>("/runs")
  }
}

// ── 事件流 ──────────────────────────────────────────────────────────────────

/**
 * 跟一轮的事件流（SSE）。**纯附着：只看，不发起任何东西。**
 *
 * ⚠️ **不能用 `EventSource`**：它只发 GET、也设不了请求头，而我们要带 `accept:
 * text/event-stream`（反代按上游 content-type 决定走不走直通），登录还靠同源 cookie。
 * 故走 `fetch` + `body.getReader()` 自己解 SSE —— 格式很简单，`id: N` 与 `data: {...}`，
 * 空行分帧。
 *
 * ⚠️ **`after` 是断点续传的关键**：断线重连时带上最后收到的序号，引擎会把之后的补给你；
 * 少了一段它还会先发一条 `CUSTOM:events_dropped` 明说少了几条 —— 静默跳过在界面上与
 * 「引擎卡住了」一模一样。
 *
 * @param onEvent 每收到一条就调一次。**别在这里抛异常**，会把整条流带崩。
 * @param signal  取消用。组件卸载时务必 abort，否则读循环会一直挂着。
 */
export async function followRun(
  saveId: string,
  onEvent: (event: RunEvent, seq: number) => void,
  options: { after?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const query = options.after ? `?after=${options.after}` : ""
  const res = await apiFetch(`${BASE}/saves/${encodeURIComponent(saveId)}/events${query}`, {
    headers: { accept: "text/event-stream" },
    signal: options.signal,
  })
  if (!res.ok || !res.body) {
    const body: unknown = await res.json().catch(() => null)
    const info = explain(body, res.status)
    throw new GalStoryError(info.message, res.status, info.hint, info.code, info.payload)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let seq = options.after ?? 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // 一帧以空行结束。⚠️ 要认 \n\n 也要认 \r\n\r\n —— 中间任何一层反代都可能改行尾
      let cut: number
      while ((cut = firstFrameEnd(buffer)) >= 0) {
        const frame = buffer.slice(0, cut)
        buffer = buffer.slice(cut).replace(/^(\r?\n){2}/, "")
        const parsed = parseFrame(frame)
        if (!parsed) continue
        if (parsed.id !== null) seq = parsed.id
        onEvent(parsed.event, seq)
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

function firstFrameEnd(buffer: string): number {
  const a = buffer.indexOf("\n\n")
  const b = buffer.indexOf("\r\n\r\n")
  if (a < 0) return b
  if (b < 0) return a
  return Math.min(a, b)
}

/** 解一帧 SSE。`data:` 可能有多行（按规范要拼起来），`id:` 是引擎给的序号 */
function parseFrame(frame: string): { event: RunEvent; id: number | null } | null {
  const data: string[] = []
  let id: number | null = null
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
    else if (line.startsWith("id:")) {
      const n = Number(line.slice(3).trim())
      if (Number.isFinite(n)) id = n
    }
  }
  if (data.length === 0) return null
  try {
    return { event: JSON.parse(data.join("\n")) as RunEvent, id }
  } catch {
    // 解不出来就丢这一帧，绝不把整条流带崩 —— 引擎以后加的事件也该是安全的
    return null
  }
}

// ── 模型配置 ────────────────────────────────────────────────────────────────

export const configApi = {
  /**
   * 连接 / 预设 / **绑定解析结果** / 体检。
   *
   * ⚠️ **`bindings` 里的 `connectionId`/`source`/`timeBudgetS` 一律直接用，别在前端重算**：
   * 三层优先级的唯一声明处是引擎的 `AgentClients.binding_of`，那个 docstring 明写着
   * 「在调用方重写一遍就等于让同一个判据有两处声明，迟早漂」。
   */
  get(): Promise<ModelConfig> {
    return request<ModelConfig>("/config")
  },

  /**
   * 改顶层那几个键（默认连接 / 核验总开关 / agent 绑定 / 日志 / skill 与插件增量）。
   *
   * `log` 与 `agentBindings` 在引擎那一侧**按键合并**，故只改一个开关时不必回传整段。
   */
  update(patch: ConfigPatch): Promise<ConfigWriteResult> {
    return request<ConfigWriteResult>("/config", { method: "PATCH", body: patch })
  },

  /** 新建或修改一条连接。`id` 走路径 —— 改 id 是「删一条建一条」，不是一次 patch */
  saveConnection(id: string, patch: ConnectionPatch): Promise<ConfigWriteResult> {
    return request<ConfigWriteResult>(`/config/connections/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: patch
    })
  },

  /**
   * 删一条连接。
   *
   * ⚠️ **还被指着时引擎会 409 并列出是谁指着它**（默认连接 / agent 绑定 / 某个环节的覆盖项）——
   * 那不是「删不掉」，是「删掉之后那几处会**静默回落**到缺省连接与缺省预设，超时/重试/预设
   * 一起丢，而现象只是模型行为莫名其妙变了」。确认之后带 `force` 再来一次。
   */
  deleteConnection(id: string, force = false): Promise<ConfigWriteResult> {
    const query = force ? "?force=true" : ""
    return request<ConfigWriteResult>(
      `/config/connections/${encodeURIComponent(id)}${query}`,
      { method: "DELETE" }
    )
  },

  savePreset(id: string, patch: PresetPatch): Promise<ConfigWriteResult> {
    return request<ConfigWriteResult>(`/config/presets/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: patch
    })
  },

  /** 删一个采样预设。还被环节指着时同样 409（理由同 `deleteConnection`） */
  deletePreset(id: string, force = false): Promise<ConfigWriteResult> {
    const query = force ? "?force=true" : ""
    return request<ConfigWriteResult>(`/config/presets/${encodeURIComponent(id)}${query}`, {
      method: "DELETE"
    })
  },

  /**
   * 新建或修改一个环节的覆盖项。
   *
   * ⚠️ 环节名必须是引擎认识的那些，否则 400。写错一个名字的后果是**整段配置静默失效**
   * （回落 `default_connect` + 缺省预设，该环节的连接/超时/提示词段全丢），故写口当场拦。
   */
  saveAgent(name: string, patch: AgentPatch): Promise<ConfigWriteResult> {
    return request<ConfigWriteResult>(`/config/agents/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: patch
    })
  },

  /**
   * 删掉一个环节的**覆盖项**（不是删这个环节 —— 环节由引擎定义）。删完它按三层优先级回落。
   *
   * ⚠️ 这会连该环节**配置拥有的提示词段**一起删掉（`prompts`/`prompt_order` 就住在这一项里）。
   */
  deleteAgent(name: string): Promise<ConfigWriteResult> {
    return request<ConfigWriteResult>(`/config/agents/${encodeURIComponent(name)}`, {
      method: "DELETE"
    })
  }
}

// ── 纯展示的派生 ─────────────────────────────────────────────────────────────

/** 三级各有几条 —— 页头那排数字 */
export function countLevels(issues: LintIssue[]): Record<LintLevel, number> {
  return issues.reduce(
    (acc, issue) => ({ ...acc, [issue.level]: (acc[issue.level] ?? 0) + 1 }),
    { error: 0, warn: 0, info: 0 } as Record<LintLevel, number>
  )
}

/**
 * 角色卡描述的**一行预览**。
 *
 * 角色卡是 sillytavern 精简格式，正文长这样：
 *
 * ```
 * Name: 沈青
 *
 * gender: 女
 * ...
 * ```
 *
 * 直接 `line-clamp-2` 出来的两行是「Name: 沈青」加一行空白 —— 零信息量，而名字就印在它上面。
 * 故预览时**去掉空行、去掉那条与上方重复的 `Name:` 行**，再用 `·` 接起来。
 *
 * 这只改预览：完整正文在磁盘上那份卡里，接口给的也是原文一个字没动。
 */
export function cardPreview(description: string): string {
  return description
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^name\s*[:：]/i.test(line))
    .join(" · ")
}

/**
 * 「N 幕 · M 场」。**没写 `stages:` 时不显示成「0 幕」** —— 引擎会自动包一个默认单场景，
 * 而那类故事没有转场、也就没有回退点，这是玩法上的真实差别。
 *
 * 选单那条口不给舞台数（只给 `scenes`），故这里两个入口各按自己拿得到的说。
 */
export function structureLabel(stages: number | null, scenes: number): string {
  if (stages === 0) return "默认单场景"
  if (stages === null) return scenes <= 1 ? "单场景" : `${scenes} 场`
  return `${stages} 幕 · ${scenes} 场`
}


/**
 * 引擎的文案用 `**…**` 标重点（那是它整个仓库的行文习惯）。原样渲染就是一串星号，
 * 而它标的恰恰是「这句话里最该看到的那半句」。
 *
 * ⚠️ **切成段自己渲染，不走 `v-html`**：这串文本来自后端，哪怕后端是本机的引擎，
 * 把它当 HTML 插进 DOM 也是一条不该开的口子。
 *
 * 这是这段逻辑的**唯一声明处** —— `LintList` 里本来有一份，删故事的确认框是第二个用它的地方，
 * 而同一件事抄两遍就会漂（一边支持了新语法、另一边没有）。
 */
export function emphasize(text: string): { text: string; strong: boolean }[] {
  return text.split("**").map((chunk, index) => ({ text: chunk, strong: index % 2 === 1 }))
}
