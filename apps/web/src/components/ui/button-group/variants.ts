import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

// 叶子模块：只依赖 cva，不 import 本目录的任何组件。
// 组件要用样式变体时从这里引，不要从 "." 引 —— index.ts 会 re-export 组件本身，
// 组件再回头引 index.ts 就成了循环依赖（见 apps/web/vite.config.ts 的 onwarn）。

export const buttonGroupVariants = cva(
  "flex w-fit items-stretch [&>*]:focus-visible:z-10 [&>*]:focus-visible:relative [&>[data-slot=select-trigger]:not([class*='w-'])]:w-fit [&>input]:flex-1 has-[select[aria-hidden=true]:last-child]:[&>[data-slot=select-trigger]:last-of-type]:rounded-r-md has-[>[data-slot=button-group]]:gap-2",
  {
    variants: {
      orientation: {
        horizontal:
          "[&>*:not(:first-child)]:rounded-l-none [&>*:not(:first-child)]:border-l-0 [&>*:not(:last-child)]:rounded-r-none",
        vertical:
          "flex-col [&>*:not(:first-child)]:rounded-t-none [&>*:not(:first-child)]:border-t-0 [&>*:not(:last-child)]:rounded-b-none",
      },
    },
    defaultVariants: {
      orientation: "horizontal",
    },
  },
)

export type ButtonGroupVariants = VariantProps<typeof buttonGroupVariants>
