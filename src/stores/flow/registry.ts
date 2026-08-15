import type { Ref } from "vue"
import type { FlowEdge, FlowNode, FlowOp, FlowOpType } from "@/types/flow"

/**
 * 画布命令注册表。
 *
 * 加一种新操作 = 新写一个命令文件、往 `commands/index.ts` 的清单里加一行，
 * 不用回来改任何分支判断。
 *
 * 和 `three-editor/commands` 的区别：那边的命令是**持有对象引用的类实例**，
 * 只活在内存里；这边的操作要序列化进 `FlowOperation` 落库、还要发给服务端，
 * 所以命令本身是**无状态的处理器**，数据全在 `FlowOp` 的 before / after 里。
 */

/** 命令能改的东西 —— 就是画布状态本身，别的一概碰不到 */
export interface FlowCommandContext {
  nodes: Ref<FlowNode[]>
  edges: Ref<FlowEdge[]>
  graphMeta: Ref<Record<string, unknown>>
}

export interface FlowCommand {
  /** 操作类型，也是注册表的键 */
  readonly type: FlowOpType
  /** 逆操作的类型。增删互为逆；自逆的命令填自己 */
  readonly inverse: FlowOpType
  /** 给人看的名字，写日志/调试用 */
  readonly name: string
  /** 把一条操作作用到画布状态上 */
  apply(ctx: FlowCommandContext, op: FlowOp): void
}

const registry = new Map<FlowOpType, FlowCommand>()

/** 注册一条命令；重复注册直接报错，免得两份实现互相覆盖还查不出来 */
export function registerFlowCommand(command: FlowCommand): FlowCommand {
  const existing = registry.get(command.type)
  if (existing && existing !== command) {
    throw new Error(`画布命令重复注册：${command.type}`)
  }
  registry.set(command.type, command)
  return command
}

export function registerFlowCommands(commands: readonly FlowCommand[]) {
  for (const command of commands) registerFlowCommand(command)
}

export function getFlowCommand(type: FlowOpType): FlowCommand | undefined {
  return registry.get(type)
}

/** 已注册的全部类型，测试和调试用 */
export function registeredFlowCommandTypes(): FlowOpType[] {
  return [...registry.keys()]
}

/** 应用一条操作；遇到没注册的类型只告警不抛 —— 别让一条脏数据卡死整张画布 */
export function applyOp(ctx: FlowCommandContext, op: FlowOp) {
  const command = getFlowCommand(op.type)
  if (!command) {
    console.warn(`[flow] 未注册的操作类型，已跳过：${op.type}`)
    return
  }
  command.apply(ctx, op)
}

export function applyOps(ctx: FlowCommandContext, ops: FlowOp[]) {
  for (const op of ops) applyOp(ctx, op)
}

/**
 * 反转一批操作：类型换成注册表里声明的逆类型、before/after 互换，
 * 顺序也要倒过来（后做的先撤）。
 */
export function invertOps(ops: FlowOp[]): FlowOp[] {
  return [...ops].reverse().map((op) => ({
    type: getFlowCommand(op.type)?.inverse ?? op.type,
    targetId: op.targetId,
    before: op.after,
    after: op.before
  }))
}
