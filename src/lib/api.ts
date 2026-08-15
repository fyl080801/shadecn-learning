import { apiFetch } from "@/lib/auth"
import type {
  FlowDetail,
  FlowGraph,
  FlowStatus,
  FlowSummary,
  FlowTransaction,
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
    const message =
      (body as { error?: string } | null)?.error ?? `请求失败（${res.status}）`
    throw new ApiError(message, res.status, body)
  }
  return body as T
}

const json = (body: unknown) => JSON.stringify(body)

function query(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ""
}

// —— 项目 ——

export const projectApi = {
  list(params: { page?: number; pageSize?: number; keyword?: string }) {
    return request<Paged<ProjectSummary>>(`/api/projects${query(params)}`)
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

  invites(projectId: string) {
    return request<ProjectInviteView[]>(`/api/projects/${projectId}/invites`)
  },

  createInvite(
    projectId: string,
    body: { expiresInDays?: number; maxUses?: number | null }
  ) {
    return request<ProjectInviteView>(`/api/projects/${projectId}/invites`, {
      method: "POST",
      body: json(body)
    })
  },

  revokeInvite(projectId: string, inviteId: string) {
    return request<void>(`/api/projects/${projectId}/invites/${inviteId}`, {
      method: "DELETE"
    })
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

  /** 提交事务；baseRevision 对不上会抛 409 的 ApiError */
  commit(
    flowId: string,
    body: {
      baseRevision: number
      transactions: FlowTransaction[]
      graph: FlowGraph
    }
  ) {
    return request<{ revision: number }>(`/api/flows/${flowId}/commit`, {
      method: "POST",
      body: json(body)
    })
  }
}
