import { defineRequest } from '@learning/cluster'

/**
 * 通知**所有**跑着 `AppsModule` 的进程：谁在跑这个任务谁停（取消，docs/29 §3.10）。丢了也有续租兜底。
 * 只有这一句：受理和执行在同一个进程，派发和补推都是本进程的方法调用（docs/30 §8）。
 */
export const APPS_CANCEL_TASK = defineRequest<{ taskId: string }, { aborted: boolean }>('apps.cancel-task')
