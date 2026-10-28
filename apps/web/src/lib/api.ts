import type {
  IdentityView,
  PendingLinkView,
  ProviderId,
  ProviderView
} from "@shadecn/shared/auth"
import type {
  FlowDetail,
  FlowStatus,
  FlowSummary,
  InvitePreview,
  Paged,
  ProjectInviteView,
  ProjectMemberView,
  ProjectSummary
} from "@shadecn/shared/canvas"
import {
  agentApiPath,
  agentConversationPath,
  agentRunEventsPath,
  type AgentConversationSummary,
  type AgentConversationView,
  type AgentPromptRequest,
  type AgentSessionView,
  type AgentStreamEvent
} from "@shadecn/shared/agent"
import type { FlowUserState } from "@shadecn/shared/flow-graph"
import { apiFetch } from "@/lib/auth"
import { readSseStream } from "@/lib/sse"

/**
 * 后端接口的薄封装。
 * 只做「发请求 + 解析 + 把非 2xx 变成异常」，业务判断留给调用方。
 */

/** 带上后端返回的状态码，调用方需要区分 409 / 404 时用得上 */
export class ApiError extends Error {
  // 不用参数属性：项目开了 erasableSyntaxOnly，构造函数参数上的修饰符不允许
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.body = body
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      accept: "application/json",
      ...init.headers
    }
  })

  if (res.status === 204) return undefined as T

  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    // 401 时 apiFetch 已经弹了「要不要去登录」的确认框，这里只把顺带冒出来的
    // 那条 toast 说人话（后端给的是 "Unauthorized"）
    const message =
      res.status === 401
        ? "登录状态已失效，请重新登录"
        : ((body as { error?: string } | null)?.error ??
          `请求失败（${res.status}）`)
    throw new ApiError(message, res.status, body)
  }
  return body as T
}

const json = (body: unknown) => JSON.stringify(body)

/**
 * 非 JSON 接口（Agent 的事件流）用的错误分支。
 *
 * 不能走 `request()`：那条路把响应体当 JSON 解，而这几个接口成功时给的是
 * `text/event-stream`。失败时服务端仍然回 JSON，所以只有这一半是共用的。
 */
async function streamFailure(res: Response): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null)
  const message =
    res.status === 401
      ? "登录状态已失效，请重新登录"
      : ((body as { error?: string } | null)?.error ?? `请求失败（${res.status}）`)
  return new ApiError(message, res.status, body)
}

function query(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ""
}

// —— 账号（登录方式）——

export const authApi = {
  /** 后端启用了哪些登录方式 */
  config() {
    return request<{
      enabled: boolean
      provider: ProviderId | null
      providers: ProviderView[]
    }>("/api/auth/config")
  },

  /** 当前用户绑了哪些，外加有没有一条在等确认 */
  identities() {
    return request<{ items: IdentityView[]; pending: PendingLinkView | null }>(
      "/api/auth/identities"
    )
  },

  /** 确认那条待关联 —— 到这一步才真的写库 */
  confirmLink() {
    return request<{ identity: IdentityView }>("/api/auth/link/confirm", {
      method: "POST"
    })
  },

  /** 放弃那条待关联 */
  cancelLink() {
    return request<void>("/api/auth/link/pending", { method: "DELETE" })
  },

  /**
   * 解绑。最后一条会被服务端挡下来（409）—— 前端也会把按钮禁掉，
   * 但两边都要有：禁用只是提示，判定得在服务端。
   */
  unlinkIdentity(id: string) {
    return request<void>(`/api/auth/identities/${id}`, { method: "DELETE" })
  },

  /**
   * 关联一条新的登录方式：**整页跳走**，不是 XHR。
   * 要经过第三方的授权页，SPA 内部跳没用（和登录、登出是同一个道理）。
   *
   * 没有「回哪儿去」这个参数：服务端一律送回设置页，因为确认框只长在那儿。
   */
  startLink(provider: ProviderId) {
    window.location.assign(`/api/auth/link/${provider}`)
  }
}

// —— 项目 ——

export const projectApi = {
  list(params: { page?: number; pageSize?: number; keyword?: string }) {
    return request<Paged<ProjectSummary>>(`/api/projects${query(params)}`)
  },

  /**
   * 我的个人空间（REQ-SOLO）。**读接口也会建** —— 第一次点进「个人画布」就有了。
   *
   * 拿到 id 之后，画布的列表 / 新建 / 改名 / 删除全都复用 `flowApi` 那几条：
   * 个人空间在接口层面就是个项目，没有第二套 CRUD。
   */
  personal() {
    return request<ProjectSummary>("/api/projects/personal")
  },

  create(body: { name: string; description?: string | null }) {
    return request<ProjectSummary>("/api/projects", {
      method: "POST",
      body: json(body)
    })
  },

  get(projectId: string) {
    return request<ProjectSummary>(`/api/projects/${projectId}`)
  },

  update(projectId: string, body: { name?: string; description?: string | null }) {
    return request<ProjectSummary>(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: json(body)
    })
  },

  remove(projectId: string) {
    return request<void>(`/api/projects/${projectId}`, { method: "DELETE" })
  },

  members(projectId: string) {
    return request<ProjectMemberView[]>(`/api/projects/${projectId}/members`)
  },

  removeMember(projectId: string, userId: string) {
    return request<void>(`/api/projects/${projectId}/members/${userId}`, {
      method: "DELETE"
    })
  },

  /** 取项目的分享链接；没有（或已过期）时服务端当场建一条，所以打开面板即有链接 */
  invite(projectId: string) {
    return request<ProjectInviteView>(`/api/projects/${projectId}/invite`)
  },

  /** 改有效期，token 不变 */
  setInviteExpiry(projectId: string, expiresInDays: number) {
    return request<ProjectInviteView>(`/api/projects/${projectId}/invite`, {
      method: "PATCH",
      body: json({ expiresInDays })
    })
  },

  /** 重置：换一个 token，旧链接立刻失效 */
  resetInvite(projectId: string, expiresInDays?: number) {
    return request<ProjectInviteView>(
      `/api/projects/${projectId}/invite/reset`,
      { method: "POST", body: json({ expiresInDays }) }
    )
  }
}

// —— 邀请（按 token，不需要先是成员）——

export const inviteApi = {
  preview(token: string) {
    return request<InvitePreview>(`/api/invites/${encodeURIComponent(token)}`)
  },

  accept(token: string) {
    return request<{ projectId: string }>(
      `/api/invites/${encodeURIComponent(token)}/accept`,
      { method: "POST" }
    )
  }
}

// —— 画布 ——

export const flowApi = {
  list(
    projectId: string,
    params: {
      page?: number
      pageSize?: number
      keyword?: string
      status?: FlowStatus
      sort?: string
    }
  ) {
    return request<Paged<FlowSummary>>(
      `/api/projects/${projectId}/flows${query(params)}`
    )
  },

  create(projectId: string, body: { name: string; description?: string | null }) {
    return request<FlowDetail>(`/api/projects/${projectId}/flows`, {
      method: "POST",
      body: json(body)
    })
  },

  get(flowId: string) {
    return request<FlowDetail>(`/api/flows/${flowId}`)
  },

  update(
    flowId: string,
    body: {
      name?: string
      description?: string | null
      status?: FlowStatus
      tags?: string[]
    }
  ) {
    return request<FlowSummary>(`/api/flows/${flowId}`, {
      method: "PATCH",
      body: json(body)
    })
  },

  remove(flowId: string) {
    return request<void>(`/api/flows/${flowId}`, { method: "DELETE" })
  },

  duplicate(flowId: string) {
    return request<FlowDetail>(`/api/flows/${flowId}/duplicate`, {
      method: "POST"
    })
  },

  /**
   * 存「我自己」的画布状态（视口…）。PATCH：只带要改的分区。
   * 跟内容提交是两条路 —— 它不涨 revision，也就没有冲突。
   */
  patchUserState(flowId: string, patch: FlowUserState) {
    return request<void>(`/api/flows/${flowId}/user-state`, {
      method: "PATCH",
      body: json(patch)
    })
  },
}

// —— 画布 Agent（REQ-AGENT，docs/20）——

/**
 * 一帧 `data:` 解成事件。解不出来、或者不像个事件，就返回 null 丢掉这一帧 ——
 * 服务端以后多发一种事件、或者某一帧被代理弄坏了，都不该把整条流带崩。
 */
export function parseAgentEvent(data: string): AgentStreamEvent | null {
  try {
    const value: unknown = JSON.parse(data)
    if (typeof value !== "object" || value === null) return null
    if (typeof (value as { type?: unknown }).type !== "string") return null
    return value as AgentStreamEvent
  } catch {
    return null
  }
}

/** 两条事件流（发起 / 接回）共用的那一半：查状态码、逐帧解成事件 */
async function readAgentStream(
  res: Response,
  options: { onEvent: (event: AgentStreamEvent) => void; onOpen?: () => void }
): Promise<void> {
  if (!res.ok) throw await streamFailure(res)
  if (!res.body) throw new ApiError("服务端没有返回事件流", res.status, null)
  options.onOpen?.()

  await readSseStream(res.body, (frame) => {
    const event = parseAgentEvent(frame.data)
    if (event) options.onEvent(event)
  })
}

export const agentApi = {
  /** 服务端有没有配模型 + 此刻有没有一轮在跑（`activeRun`）+ 默认打开的会话（含消息） */
  session(flowId: string) {
    return request<AgentSessionView>(agentApiPath(flowId))
  },

  /**
   * 发一条 prompt，**响应体就是这一轮的事件流**（AG-UI，见 `@shadecn/shared/agent`）。
   *
   * 不能用 `EventSource`（它只会 GET），所以 `fetch` 之后自己读流、自己解 SSE。
   * 非 2xx 时流根本没开始，抛 `ApiError`：409 = 这张画布有一轮正在跑，
   * 503 = 服务端没配模型，400 = 参数不对；401 由 `apiFetch` 弹重新登录框。
   *
   * resolve 的时机是**流结束**（服务端关流 / `signal` 中止），不是收到最后一个事件。
   */
  async send(
    flowId: string,
    body: AgentPromptRequest,
    options: {
      onEvent: (event: AgentStreamEvent) => void
      /** 响应是 2xx、流开始了 —— 从这一刻起这一轮就算服务端接下了，之后断开也不是「没发出去」 */
      onOpen?: () => void
      signal?: AbortSignal
    }
  ): Promise<void> {
    const res = await apiFetch(`${agentApiPath(flowId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: json(body),
      signal: options.signal
    })
    await readAgentStream(res, options)
  },

  /**
   * 接回一轮正在跑的（`agentRunEventsPath`）：服务端先从 RUN_STARTED 起补发这一轮的全部事件，
   * 再接着推后续的，收尾后关流 —— 和 `send` 的流一模一样，所以 resolve 时机也一样（流结束）。
   *
   * 非 2xx 抛 `ApiError`：404 = 这一轮已经结束 / 不是你的，410 = 补发缓冲溢出、接不回来了。
   */
  async runEvents(
    flowId: string,
    runId: string,
    options: { onEvent: (event: AgentStreamEvent) => void; signal?: AbortSignal }
  ): Promise<void> {
    const res = await apiFetch(agentRunEventsPath(flowId, runId), {
      headers: { accept: "text/event-stream" },
      signal: options.signal
    })
    await readAgentStream(res, options)
  },

  /** 停掉这张画布上正在跑的那一轮；已经提交到画布上的改动保留 */
  abort(flowId: string) {
    return request<void>(`${agentApiPath(flowId)}/abort`, { method: "POST" })
  },

  /** 「我」在这张画布上的会话列表（已按更新时间倒序） */
  conversations(flowId: string) {
    return request<AgentConversationSummary[]>(agentConversationPath(flowId))
  },

  /** 一个会话的全部内容 */
  conversation(flowId: string, conversationId: string) {
    return request<AgentConversationView>(agentConversationPath(flowId, conversationId))
  },

  /** 删除一个会话（它正在跑时 409，不存在 404） */
  deleteConversation(flowId: string, conversationId: string) {
    return request<void>(agentConversationPath(flowId, conversationId), { method: "DELETE" })
  }
}
