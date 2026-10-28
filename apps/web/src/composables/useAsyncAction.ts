import { computed, reactive } from "vue"
import { toast } from "vue-sonner"

/**
 * 「一次点击一次请求」—— 会发请求的交互统一走这里。
 *
 * 关键在于**同步上锁**：`run()` 一进来就把 key 记进 pending 集合，
 * 不等 response，所以同一轮事件循环里的第二次点击（双击、连按回车、
 * blur + enter 一起触发的提交）当场被丢掉，请求只会发出去一次。
 *
 * 光靠模板上的 `:disabled` 是不够的 —— disabled 要等 Vue 下一次渲染才生效，
 * 那之前的重复事件照样能进 handler；而且很多入口（回车、菜单项、blur）
 * 根本就没有那个按钮可禁用。守卫必须在函数里。
 *
 * ```ts
 * const { run: submit, pending } = useAsyncAction(async () => {
 *   const project = await projectApi.create({ name })
 *   void router.push(`/projects/${project.id}`)
 * }, { errorMessage: "创建失败" })
 * ```
 * ```vue
 * <Button :loading="pending" @click="submit()">创建</Button>
 * ```
 *
 * 模板里**要写 `submit()` 而不是 `submit`**：写成后者会把 MouseEvent 当参数传进去。
 */

export type AsyncActionKey = string | number

export interface AsyncActionOptions<A extends unknown[]> {
  /** 异常没有 message 时的兜底文案 */
  errorMessage?: string
  /** 列表场景：按这个 key 分别记 pending，删 A 行不会禁用 B 行 */
  key?: (...args: A) => AsyncActionKey
  /** 自定义错误处理；给了就不再弹 toast */
  onError?: (error: unknown) => void
}

/** 没有 key 的动作共用这一个槽位 */
const SINGLE: AsyncActionKey = "__single__"

export function useAsyncAction<A extends unknown[], R>(
  action: (...args: A) => Promise<R> | R,
  options: AsyncActionOptions<A> = {}
) {
  const running = reactive(new Set<AsyncActionKey>())

  /** 任意一个在跑就是 true；单动作场景直接用它绑 `:loading` */
  const pending = computed(() => running.size > 0)

  /** 列表场景：只问某一行在不在跑 */
  function isPending(key: AsyncActionKey) {
    return running.has(key)
  }

  /**
   * 触发一次动作。正在跑就直接返回 `undefined`，不排队、不合并。
   * 永远不会 reject —— 模板上直接 `@click` 挂它不会留下未处理的 rejection。
   */
  function run(...args: A): Promise<R | undefined> {
    const key = options.key ? options.key(...args) : SINGLE
    if (running.has(key)) return Promise.resolve(undefined)
    running.add(key)

    return (async () => {
      try {
        return await action(...args)
      } catch (error) {
        if (options.onError) options.onError(error)
        else
          toast.error(
            error instanceof Error ? error.message : (options.errorMessage ?? "操作失败")
          )
        return undefined
      } finally {
        running.delete(key)
      }
    })()
  }

  return { run, pending, isPending }
}

export type AsyncAction<A extends unknown[], R> = ReturnType<typeof useAsyncAction<A, R>>
