import { toast } from "vue-sonner"
import { nodeAppParams } from "@shadecn/shared/apps"

import {
  collectNodeAppInputs,
  nodeAppOverrides,
  nodeAppCategory,
  noAppHint,
  resolveNodeApp
} from "@/components/flow/apps/node-app"
import { useApps } from "@/composables/useApps"
import { flowAppTasksFor } from "@/composables/flow/useFlowAppTasks"
import { ApiError, appApi } from "@/lib/api"

import { defineNodeFeature, defineNodeHandler, type NodeEventSource } from "../protocol"

/**
 * 用应用生成节点内容（docs/29 §3.8、§3.10）—— `runnable` 的运行器：接住 `node:run`，
 * 拿节点选的应用（`components/flow/apps/node-app.ts`）、节点的提示词和连进来的参考图，
 * **提交一个生成任务**（`POST /api/flows/:flowId/apps/:appId/execute`）就返回 —— 执行、存资源、把产物挂回节点都在服务端，
 * 关掉页面也照样挂回去。
 *
 * - **不写节点的 `runtime`**：节点的运行状态只有执行副本写（凭发起人的执行身份，`processing` = 执行副本已经在跑）。
 *   提交成功只把任务放进画布的任务列表（`useFlowAppTasks`，推送到了整份替换）—— 排队中的节点据此显示「排队中」；
 * - 提交失败（参数、应用不可用、没有执行实例）：只提示服务端那句话（没建任务，节点不带错误态）；409（这个节点已有进行中的任务）只提示；
 * - **同一个节点同时只有一个任务**：服务端判（409）；本窗口里提交还没回来时再发只提示，节点有进行中的任务时再发也只提示
 *   （底部输入框的发送按钮这时本来就转圈、不可点，见 `useFlowAppTasks().isGenerating`）；
 * - 不认识具体类型：节点产出什么类别看它的输出端口（`nodeAppCategory`）。
 */

/** 本窗口里提交还没回来的节点（`flowId:nodeId`）：同一拍点两次只发一个请求 */
const submitting = new Set<string>()

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return err instanceof Error ? err.message : String(err)
}

export async function runNodeApp(ctx: NodeEventSource, promptOverride?: string): Promise<void> {
  const flowId = ctx.editor.flowId.value
  const key = `${flowId}:${ctx.id}`
  const node = ctx.node.node.value
  const category = nodeAppCategory(ctx.type)
  if (!category || !node) return
  const tasks = flowAppTasksFor(flowId)
  if (submitting.has(key) || tasks?.isGenerating(ctx.id)) {
    toast.info("这个节点正在生成，等它完成或先取消")
    return
  }

  const store = ctx.editor.store
  const { apps, ensure } = useApps()
  submitting.add(key)
  // 画布那份任务列表也记一笔：底部输入框的发送按钮据此转圈、不可再点（`isGenerating`）
  const unmark = tasks?.markSubmitting(ctx.id)
  try {
    await ensure()
    const app = resolveNodeApp(apps.value, category, node.data)
    if (!app) {
      toast.error("还没有可用的生成应用", { description: noAppHint(category) })
      return
    }
    if (app.unavailable) {
      toast.error(`「${app.title}」现在用不了`, { description: app.unavailable })
      return
    }

    const prompt = promptOverride ?? (typeof node.data.prompt === "string" ? node.data.prompt : "")
    const inputs = collectNodeAppInputs(node, prompt, store.nodeById)
    const { params, droppedImages } = nodeAppParams(app, inputs, nodeAppOverrides(node.data))
    if (droppedImages > 0) toast.warning(`有 ${droppedImages} 张参考图超出了这个模型的上限，没有用上`)

    try {
      const task = await appApi.submitOnFlow(flowId, app.id, { params, nodeId: ctx.id })
      tasks?.upsert(task)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.info("这个节点正在生成，等它完成或先取消")
        return
      }
      toast.error("生成没有提交成功", { description: errorText(err) })
    }
  } finally {
    submitting.delete(key)
    unmark?.()
  }
}

export const appRunFeature = defineNodeFeature({
  id: "app-run",
  handlers: [
    defineNodeHandler({
      event: "node:run",
      handle: ({ prompt }, ctx) => {
        void runNodeApp(ctx, prompt)
      }
    })
  ]
})
