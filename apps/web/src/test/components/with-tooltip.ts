import { defineComponent, h, type Component } from "vue"
import { TooltipProvider } from "@/components/ui/tooltip"

/**
 * 应用里 TooltipProvider 只在 App.vue 挂一次，单独挂载组件时没有它，里面的 Tooltip 会因为
 * 找不到 Provider 上下文而报错。用它把被测组件包一层（props / 插槽原样透传）：
 * `mount(withTooltipProvider(X), { props, slots })`。
 */
export function withTooltipProvider(component: Component) {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h(TooltipProvider, null, () => h(component, attrs, slots))
    }
  })
}
