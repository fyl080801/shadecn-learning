import { DEFAULT_SHUTDOWN_TIMEOUT_MS, type ModuleContext, type ModuleHandle, type ServerModule } from './module.ts'

/** 装配完的一组模块 */
export interface LoadedModules<App = unknown> {
  /** 按装配顺序 */
  readonly modules: readonly ServerModule<App>[]
  /** 全部 `ready()`，按装配顺序串行 */
  ready(): Promise<void>
  /** 按装配的逆序收尾，每个带上限；可重入（第二次调直接返回同一个 Promise） */
  shutdown(): Promise<void>
}

/**
 * 按顺序装配模块（docs/28 §3.1.3 第 2～4 步）。
 *
 * - `setup` 串行：后面的模块可能要 `ctx.service()` 前面注册的服务；
 * - 任一 `setup` 抛错就整体失败 —— 那是配置错，不是运行时故障，进程不该带着半套模块监听端口；
 * - 收尾逆序、每个带上限：超时只记一笔不阻断后面的。一个模块收尾卡死不能拖着别的模块落不了库。
 */
export async function startModules<App>(
  ordered: readonly ServerModule<App>[],
  context: Omit<ModuleContext<App>, 'service' | 'provide'>,
): Promise<LoadedModules<App>> {
  const services = new Map<string, unknown>()
  const handles: { module: ServerModule<App>; handle: ModuleHandle }[] = []

  for (const module of ordered) {
    const ctx: ModuleContext<App> = {
      ...context,
      service: <T>(name: string) => services.get(name) as T | undefined,
      provide: (name, value) => {
        if (!module.provides?.includes(name)) {
          throw new Error(`[kernel] 模块 ${module.name} 注册了没在 provides 里声明的服务 ${name}`)
        }
        if (services.has(name)) throw new Error(`[kernel] 服务 ${name} 已经被注册过`)
        services.set(name, value)
      },
    }
    const handle = await module.setup(ctx)
    for (const name of module.provides ?? []) {
      if (!services.has(name)) throw new Error(`[kernel] 模块 ${module.name} 声明了 provides ${name} 却没有注册`)
    }
    handles.push({ module, handle: handle ?? {} })
  }

  let closing: Promise<void> | undefined

  return {
    modules: ordered,
    async ready() {
      for (const { handle } of handles) await handle.ready?.()
    },
    shutdown() {
      closing ??= (async () => {
        for (const { module, handle } of [...handles].reverse()) {
          if (!handle.shutdown) continue
          await withDeadline(
            Promise.resolve().then(() => handle.shutdown?.()),
            handle.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
            `模块 ${module.name} 收尾`,
          )
        }
      })()
      return closing
    },
  }
}

/**
 * 给一段收尾工作加个上限；超时或抛错都只记一笔，不阻断后面的步骤。
 *
 * **必须有上限**：数据库要是进了网络黑洞，一个 `await` 就永远回不来 —— 然后 k8s 到点 SIGKILL，
 * 连后面的清理都没跑。卡死等来的是最糟的结局。
 */
export async function withDeadline(task: Promise<unknown>, ms: number, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[shutdown] ${label}超过 ${ms}ms 仍未完成，不再等待`)
      resolve()
    }, ms)
  })

  try {
    await Promise.race([task.catch((err: unknown) => console.error(`[shutdown] ${label}失败`, err)), deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
