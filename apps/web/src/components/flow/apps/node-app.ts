import { appParamsFor, type AppCategory, type AppInfo, type NodeAppInputs, type ParamSpec } from "@shadecn/shared/apps"
import { NODE_MENTION_PATTERN } from "@shadecn/shared/agent"
import type { FlowNode } from "@shadecn/shared/flow-graph"
import { hasNodeResource, portsOf, type PortDef } from "@shadecn/shared/flow-node-types"

import { INPUT_ORDER_KEY, orderedUpstreams, readInputOrder } from "@/components/flow/composer/composer-inputs"

/**
 * 画布节点用应用生成内容（docs/29 §3.8）的纯逻辑：节点选的是哪个应用 / 模型、节点的输入怎么变成应用的输入。
 * 不碰组件、不发请求、不写文档 —— 选择器（`AppPicker.vue`）和运行器（能力 `app-run`）都从这里取。
 *
 * 节点上的两个业务字段（平铺在 `data` 上，docs/13 §3.7）：`appId`（用哪个应用）、`appModel`（多模型应用里选的模型）。
 * 没选 / 选的已经不在了 = 用这个类别里第一个可用的应用、应用的默认模型 —— 读的一侧不回写。
 */
export const NODE_APP_KEY = "appId"
export const NODE_APP_MODEL_KEY = "appModel"
/**
 * 节点上单独设的应用参数（尺寸…）：一个参数一个键，`appParam.<参数名>`，平铺在 `data` 上（集合的写法，docs/13 §3.7）——
 * 两个人一个改尺寸一个改别的参数不会互相盖掉。换了应用 / 模型不清掉：值不合新模型的说明时执行不带它（`nodeAppParams`）
 */
export const NODE_APP_PARAM_PREFIX = "appParam."

/** 节点上单独设的参数（去掉前缀） */
export function nodeAppOverrides(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith(NODE_APP_PARAM_PREFIX) && value !== undefined && value !== null && value !== "") {
      out[key.slice(NODE_APP_PARAM_PREFIX.length)] = value
    }
  }
  return out
}

/** 这个选择下的尺寸参数（第一个 `size` 类型的参数）；没有 = null */
export function sizeParamOf(choice: NodeAppChoice): { name: string; spec: ParamSpec } | null {
  const found = Object.entries(appParamsFor(choice.app, choice.model)).find(([, spec]) => spec.type === "size")
  return found ? { name: found[0], spec: found[1] } : null
}

/** 节点产出什么类别：看它第一个输出端口的数据类型（图片节点 → image，视频节点 → video）；不是应用类别的 → null */
export function nodeAppCategory(type: string): AppCategory | null {
  const dataType = portsOf(type, "outputs")[0]?.dataType
  return dataType === "image" || dataType === "video" || dataType === "text" || dataType === "audio" ? dataType : null
}

export interface NodeAppChoice {
  app: AppInfo
  /** 定下来的模型；不要模型的应用 = undefined */
  model: string | undefined
}

/** 这个类别能选的应用（不可用的也列出来，界面上置灰带原因） */
export function appsOfCategory(apps: readonly AppInfo[], category: AppCategory): AppInfo[] {
  return apps.filter((app) => app.category === category)
}

/** 节点现在用哪个应用、哪个模型 */
export function resolveNodeApp(
  apps: readonly AppInfo[],
  category: AppCategory,
  data: Readonly<Record<string, unknown>>
): NodeAppChoice | null {
  const candidates = appsOfCategory(apps, category)
  const picked = candidates.find((app) => app.id === data[NODE_APP_KEY])
  const app = picked ?? candidates.find((item) => !item.unavailable) ?? candidates[0]
  if (!app) return null
  const wanted = data[NODE_APP_MODEL_KEY]
  const model =
    picked && typeof wanted === "string" && app.models.some((item) => item.id === wanted) ? wanted : app.defaultModel
  return { app, model }
}

/** 选中的模型用不了的原因（应用整个不可用时是应用的原因） */
export function choiceUnavailable(choice: NodeAppChoice): string | null {
  if (choice.app.unavailable) return choice.app.unavailable
  return choice.app.models.find((item) => item.id === choice.model)?.unavailable ?? null
}

/** 这个选择下最多收几张参考图；收不了图 = 0，不设上限 = null */
export function referenceImageLimit(choice: NodeAppChoice): number | null {
  const schema = appParamsFor(choice.app, choice.model)
  const multi = Object.values(schema).find((spec) => spec.type === "images")
  if (multi) return multi.maxLength ?? null
  return Object.values(schema).some((spec) => spec.type === "image") ? 1 : 0
}

/**
 * 人往生成节点上连图时的条数上限（docs/29 §3.8）：图片端口按节点选的应用 / 模型的参考图上限收紧。
 * 交给连线上下文的 `inputLimit`（`useFlowCanvas`），拖线、落在节点身上、输入框里的加号都按它拒；没有应用 / 不限张数 = 不收紧。
 */
export function appInputLimit(
  apps: readonly AppInfo[],
  type: string,
  data: Readonly<Record<string, unknown>>,
  port: PortDef
): { max: number; reason: string } | undefined {
  if (port.dataType !== "image") return undefined
  const category = nodeAppCategory(type)
  const choice = category ? resolveNodeApp(apps, category, data) : null
  if (!choice) return undefined
  const limit = referenceImageLimit(choice)
  if (limit === null) return undefined
  const model = choice.app.models.find((item) => item.id === choice.model)
  const name = model?.title ?? choice.model ?? choice.app.title
  return { max: limit, reason: limit === 0 ? `${name} 不收参考图` : `${name} 最多连 ${limit} 张参考图` }
}

/**
 * 节点的输入 → 应用的输入：
 * - **参考图**：连进来的、有图的上游（输出端口是图片），按底部输入框里的连入顺序（`data.inputOrder`）；
 * - **提示词**：节点自己的提示词，里面对上游的提及换成文字 —— 提及的是参考图就换成「图N」（N 是它在参考图里的序号，
 *   方舟这类接口按「图1」「图2」认图），提及的是文本节点就换成它的正文，其余换成节点名；
 *   连进来但没被提及的文本节点，正文按连入顺序接在提示词前面。
 */
export function collectNodeAppInputs(
  node: Pick<FlowNode, "inputs" | "data">,
  prompt: string,
  nodeById: ReadonlyMap<string, FlowNode>
): NodeAppInputs {
  const upstreams = orderedUpstreams(node.inputs, readInputOrder(node.data[INPUT_ORDER_KEY]), (id) => nodeById.has(id))
  const images: string[] = []
  const imageIndex = new Map<string, number>()
  const texts = new Map<string, string>()
  for (const id of upstreams) {
    const upstream = nodeById.get(id)!
    const type = upstream.type ?? ""
    const outputs = portsOf(type, "outputs")
    if (outputs.some((port) => port.dataType === "image") && hasNodeResource(type, upstream.data)) {
      imageIndex.set(id, images.length)
      images.push(String(upstream.data.src))
    } else if (outputs.some((port) => port.dataType === "text") && hasNodeResource(type, upstream.data)) {
      texts.set(id, String(upstream.data.text).trim())
    }
  }

  const mentioned = new Set<string>()
  // 全局正则的 replace 每次从头扫、用完复位 lastIndex，共用这一份常量没问题
  const body = prompt.replace(NODE_MENTION_PATTERN, (_match, id: string) => {
    mentioned.add(id)
    const index = imageIndex.get(id)
    if (index !== undefined) return `图${index + 1}`
    const text = texts.get(id)
    if (text !== undefined) return text
    return nodeById.get(id)?.metadata.label ?? ""
  })
  const leading = [...texts].filter(([id]) => !mentioned.has(id)).map(([, text]) => text)
  return { prompt: [...leading, body.trim()].filter(Boolean).join("\n"), images }
}
