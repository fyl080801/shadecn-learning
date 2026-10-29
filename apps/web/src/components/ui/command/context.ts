import type { Ref } from "vue"
import { createContext } from "reka-ui"

// 叶子模块：只依赖 reka-ui，不 import 本目录的任何组件。
// 组件要拿上下文时从这里引，不要从 "." 引 —— index.ts 会 re-export 组件本身，
// 组件再回头引 index.ts 就成了循环依赖（见 apps/web/vite.config.ts 的 onwarn）。

export const [useCommand, provideCommandContext] = createContext<{
  allItems: Ref<Map<string, string>>
  allGroups: Ref<Map<string, Set<string>>>
  filterState: {
    search: string
    filtered: { count: number, items: Map<string, number>, groups: Set<string> }
  }
}>("Command")

export const [useCommandGroup, provideCommandGroupContext] = createContext<{
  id?: string
}>("CommandGroup")
