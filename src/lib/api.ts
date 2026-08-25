import { apiFetch } from "@/lib/auth"
import type {
  AuthIdentity,
  AuthProviderView,
  PendingLink,
  ProviderId
} from "@/types/auth"
import type {
  FlowDetail,
  FlowStatus,
  FlowSummary,
  FlowUserState,
  InvitePreview,
  Paged,
  ProjectInviteView,
  ProjectMemberView,
  ProjectSummary
} from "@/types/flow"

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
 * 二进制接口（个人画布的内容通道）用的错误分支。
 *
 * 不能走 `request()`：那条路把响应体当 JSON 解，而这两个接口成功时给的是
 * `application/octet-stream`。失败时服务端仍然回 JSON，所以只有这一半是共用的。
 */
async function binaryFailure(res: Response): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null)
  const message =
    res.status === 401
      ? "登录状态已失效，请重新登录"
      : ((body as { error?: string } | null)?.error ?? `请求失败（${res.status}）`)
  return new ApiError(message, res.status, body)
}

/** 状态向量走 URL 和 JSON，得是文本；它只有几十字节，这点开销无所谓 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
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
      providers: AuthProviderView[]
    }>("/api/auth/config")
  },

  /** 当前用户绑了哪些，外加有没有一条在等确认 */
  identities() {
    return request<{ items: AuthIdentity[]; pending: PendingLink | null }>(
      "/api/auth/identities"
    )
  },

  /** 确认那条待关联 —— 到这一步才真的写库 */
  confirmLink() {
    return request<{ identity: AuthIdentity }>("/api/auth/link/confirm", {
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

  /**
   * 个人画布的内容通道（REQ-SOLO）：拉一次基线。
   *
   * 带上自己的状态向量就只拿差量。**项目画布走这条会得到 409** ——
   * 它的内容在 WebSocket 上，两条通道各自只服务自己的模式。
   */
  async pullDoc(
    flowId: string,
    since?: Uint8Array
  ): Promise<{ update: Uint8Array; stateVector: Uint8Array }> {
    const suffix = since ? `?sv=${toBase64Url(since)}` : ""
    const res = await apiFetch(`/api/flows/${flowId}/doc${suffix}`, {
      headers: { accept: "application/octet-stream" }
    })
    if (!res.ok) throw await binaryFailure(res)

    // 响应头里那份是**服务端自己的**进度，不是「我合并完会变成什么样」——
    // 拿本地状态当基线的话，离线时攒的改动会被算成已同步，从此推不出去
    const header = res.headers.get("x-flow-state-vector")
    return {
      update: new Uint8Array(await res.arrayBuffer()),
      stateVector: header ? fromBase64Url(header) : new Uint8Array()
    }
  },

  /**
   * 推一段 Yjs 增量上去，拿回服务端合并之后的状态向量。
   *
   * 下一次就以它为基线算差量（`Y.encodeStateAsUpdate(doc, stateVector)`）——
   * 客户端因此不用维护「待确认队列」：Yjs 的合并是幂等的，重发天然安全。
   */
  async pushDoc(
    flowId: string,
    update: Uint8Array
  ): Promise<{ stateVector: Uint8Array; revision: number; noop: boolean }> {
    const res = await apiFetch(`/api/flows/${flowId}/doc`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", accept: "application/json" },
      // 切出自己那段 buffer：Yjs 给的可能是共享 buffer 上的一个视图
      body: update.slice().buffer as ArrayBuffer
    })
    if (!res.ok) throw await binaryFailure(res)

    const body = (await res.json()) as { stateVector: string; revision: number; noop: boolean }
    return {
      stateVector: fromBase64Url(body.stateVector),
      revision: body.revision,
      noop: body.noop
    }
  }
}
