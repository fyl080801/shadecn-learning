import { defineRequest } from '@shadecn/server-kit/bus'

/**
 * 生成任务在角色之间的两句话（docs/29 §3.10）。单独一个文件：web 的路由只要这两个令牌，
 * 不该因此 import 执行侧（`task-runner.ts` 带着协同实例和 Yjs）。
 */

/** web → 一个 agent 副本：执行这个任务（副本抢到租约才执行；`accepted: false` = 别人已接手 / 已结束） */
export const APPS_RUN_TASK = defineRequest<{ taskId: string }, { accepted: boolean }>('apps.run-task')

/** web → 全部 agent 副本：谁在跑它谁停（取消）。丢了也有续租兜底 */
export const APPS_CANCEL_TASK = defineRequest<{ taskId: string }, { aborted: boolean }>('apps.cancel-task')

/**
 * web → 一个 agent 副本：推送一次这张画布的任务列表。排队中的任务被取消时用 —— 它没有执行方替它推送，
 * 别的协作者的列表里它会一直挂着（节点 `runtime` 只有执行方写，排队中的任务在文档里没有痕迹，前端没法拿文档对账）
 */
export const APPS_PUSH_TASKS = defineRequest<{ flowId: string }, { pushed: boolean }>('apps.push-tasks')
