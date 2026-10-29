import { cva } from "class-variance-authority"

// 叶子模块：只依赖 cva，不 import 本目录的任何组件。
// 组件要用样式变体时从这里引，不要从 "." 引 —— index.ts 会 re-export 组件本身，
// 组件再回头引 index.ts 就成了循环依赖（见 apps/web/vite.config.ts 的 onwarn）。

export const navigationMenuTriggerStyle = cva(
  "group inline-flex h-9 w-max items-center justify-center rounded-md bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=open]:hover:bg-accent data-[state=open]:text-accent-foreground data-[state=open]:focus:bg-accent data-[state=open]:bg-accent/50 focus-visible:ring-ring/50 outline-none transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1",
)
