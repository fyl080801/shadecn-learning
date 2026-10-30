import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

// 叶子模块：只依赖 cva，不 import 本目录的任何组件。
// 组件要用样式变体时从这里引，不要从 "." 引 —— index.ts 会 re-export 组件本身，
// 组件再回头引 index.ts 就成了循环依赖（见 apps/web/vite.config.ts 的 onwarn）。

export const emptyMediaVariants = cva(
  "mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "bg-muted text-foreground flex size-10 shrink-0 items-center justify-center rounded-lg [&_svg:not([class*='size-'])]:size-6",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

export type EmptyMediaVariants = VariantProps<typeof emptyMediaVariants>
