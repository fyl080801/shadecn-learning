/**
 * 给画布 agent 的入口（REQ-MODULES，docs/28 §3.4.2）：agent 经 Hocuspocus 的 direct connection 打开**活房间**写画布，
 * 要的就是这几样 —— 本进程的协同实例、房间名、配额闸、按状态向量读增量。
 *
 * 它不是普通的「契约」（契约只依赖 server-kit，没开协同的进程也能 import）：agent 模块硬依赖协同模块
 * （`dependsOn: ['collab']`，agent 角色的进程总带着一个 headless 的协同实例），所以可以拿实现。
 * 但只能经这个入口拿 —— agent 不 import 协同的其它内部文件。
 */
export { collabInstance, type CollabContext } from './hocuspocus.ts'
export { roomOf } from './persistence.ts'
export { quotaLocked } from './quota.ts'
export { readFlowUpdate } from './flow-writer.ts'
