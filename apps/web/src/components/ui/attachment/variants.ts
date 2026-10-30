import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

// 叶子模块：只依赖 cva，不 import 本目录的任何组件。
// 组件要用样式变体时从这里引，不要从 "." 引 —— index.ts 会 re-export 组件本身，从 "." 引就成环，构建会拒绝（vite.config.ts 的 onwarn）。

export const attachmentVariants = cva(
  "rounded-xl w-fit focus-within:ring-1 focus-within:ring-ring/50 group/attachment relative flex max-w-full min-w-0 shrink-0 flex-wrap border bg-card text-card-foreground transition-colors has-[>a,>button]:hover:bg-muted/50 data-[state=error]:border-destructive/30 data-[state=idle]:border-dashed",
  {
    variants: {
      size: {
        default: "gap-2 has-data-[slot=attachment-content]:px-2.5 has-data-[slot=attachment-content]:py-2 has-data-[slot=attachment-media]:p-2 text-sm",
        sm: "gap-2.5 has-data-[slot=attachment-content]:px-2 has-data-[slot=attachment-content]:py-1.5 has-data-[slot=attachment-media]:p-1.5 text-xs",
        xs: "gap-1.5 has-data-[slot=attachment-content]:px-1.5 has-data-[slot=attachment-content]:py-1 has-data-[slot=attachment-media]:p-1 text-xs rounded-lg",
      },
      orientation: {
        horizontal: "min-w-40 items-center",
        vertical: "w-24 has-data-[slot=attachment-content]:w-30 flex-col",
      },
    },
  },
)

export type AttachmentVariants = VariantProps<typeof attachmentVariants>

export const attachmentMediaVariants = cva(
  "bg-muted text-foreground w-10 rounded-lg group-data-[size=sm]/attachment:w-8 group-data-[size=xs]/attachment:w-7 group-data-[size=xs]/attachment:rounded-md [&_svg:not([class*='size-'])]:size-4 group-data-[size=xs]/attachment:[&_svg:not([class*='size-'])]:size-3.5 group-data-[orientation=vertical]/attachment:w-full group-data-[orientation=vertical]/attachment:[&_svg:not([class*='size-'])]:size-6 group-data-[orientation=vertical]/attachment:*:data-[slot=spinner]:size-6! relative flex aspect-square shrink-0 items-center justify-center overflow-hidden group-data-[state=error]/attachment:bg-destructive/10 group-data-[state=error]/attachment:text-destructive [&_svg]:pointer-events-none",
  {
    variants: {
      variant: {
        icon: "",
        image:
          "opacity-60 group-data-[state=idle]/attachment:opacity-100 group-data-[state=done]/attachment:opacity-100 *:[img]:aspect-square *:[img]:w-full *:[img]:object-cover",
      },
    },
    defaultVariants: {
      variant: "icon",
    },
  },
)

export type AttachmentMediaVariants = VariantProps<typeof attachmentMediaVariants>
