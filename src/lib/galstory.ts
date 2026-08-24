import { apiFetch } from "@/lib/auth"
import type {
  LintIssue,
  LintLevel,
  ModelConfig,
  SaveLine,
  SaveSummary,
  StoryDetail,
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

  constructor(message: string, status: number, hint = "") {
    super(message)
    this.name = "GalStoryError"
    this.status = status
    this.hint = hint
  }
}

/** 没配 `GAL_STORY_API_URL` —— 是「没开这块功能」，不是「坏了」，两者的下一步动作完全不同 */
export const NOT_CONFIGURED = 503

async function request<T>(path: string): Promise<T> {
  const res = await apiFetch(`${BASE}${path}`, { headers: { accept: "application/json" } })
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const payload = body as { detail?: string; error?: string; hint?: string } | null
    throw new GalStoryError(
      payload?.detail ?? payload?.error ?? `请求失败（${res.status}）`,
      res.status,
      payload?.hint ?? ""
    )
  }
  return body as T
}

// ── 故事 ────────────────────────────────────────────────────────────────────

export const storyApi = {
  /**
   * 故事选单。**它只有那么几个字段**，不是接口没做完 —— 引擎刻意不在这条口上给
   * `core_conflict`/`ending`/开场白（见 `types/galstory.ts` 模块头第 2 条）。
   */
  list(): Promise<StorySummary[]> {
    return request<StorySummary[]>("/stories")
  },

  /** 作者面详情：角色、编制、知识计数、节拍旋钮、作者态体检 */
  get(name: string): Promise<StoryDetail> {
    return request<StoryDetail>(`/stories/${encodeURIComponent(name)}`)
  }
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
