<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { ListboxFilter } from "reka-ui"
import { Check, ChevronsUpDown, Search } from "@lucide/vue"

import { Button } from "@/components/ui/button"
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import {
  AUTO,
  browserTimeZone,
  commonTimeZoneEntries,
  intlTimeZoneReliable,
  isSupportedTimeZone,
  searchTimeZones
} from "@/lib/preferences"

/**
 * 时区选择器：一个能打关键字的下拉。
 *
 * 为什么不是普通 Select —— 全量 IANA 表有四百多条，靠滚是找不到的。
 * 过滤逻辑没有交给 Command 内建的那套（它是「先全渲染、再按 textContent 藏」），
 * 四百多个 ListboxItem 全塞进 DOM 光打开就卡；这里改成自己过滤 + 截断，
 * 键盘上下键和回车选中仍然由 Command（ListboxRoot）负责，输入框用它的
 * ListboxFilter，所以焦点在输入框里也能用方向键走列表。
 */

const value = defineModel<string>({ required: true })

/** 没输关键字时先摆常用的那几个，省得一上来就是一屏 Africa/… */
const MAX_ITEMS = 100

const open = ref(false)
const keyword = ref("")

const browserZone = browserTimeZone()

/**
 * Intl 被扩展劫持时，每个时区算出来的偏移都是同一个（清一色 GMT-7 这种）。
 * 与其把一列错的偏移摆出来误导人，不如不显示 —— 设置页顶上有明确的说明。
 */
const showOffset = intlTimeZoneReliable()

const result = computed(() => searchTimeZones(keyword.value, MAX_ITEMS))

/** 「跟随浏览器」那一项也参与搜索：搜 auto / 浏览器 / 它背后的时区名都能出来 */
const autoMatches = computed(() => {
  const terms = keyword.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const haystack = `auto 跟随浏览器 browser ${browserZone}`.toLowerCase()
  return terms.every((t) => haystack.includes(t))
})

/** 空关键字时只列常用的；一旦开始输入就在全量里搜 */
const items = computed(() =>
  keyword.value.trim() ? result.value.items : commonTimeZoneEntries()
)

const hiddenCount = computed(() =>
  keyword.value.trim() ? result.value.total - items.value.length : 0
)

/**
 * 界面上一律显示**实际会生效**的那个值，不是存进去的原始值。
 * 存了一个 Intl 不认的时区时，格式化那边会退回「跟随浏览器」；这里要是还照着
 * 原值显示，就成了「按钮上写着某时区，时间却按本机时区走」，而且完全看不出原因。
 */
const effective = computed(() =>
  value.value !== AUTO && isSupportedTimeZone(value.value) ? value.value : AUTO
)

const triggerLabel = computed(() =>
  effective.value === AUTO ? `跟随浏览器（${browserZone}）` : effective.value
)

/** 每次重新打开都从干净的搜索框开始，免得还留着上次搜了一半的词 */
watch(open, (isOpen) => {
  if (isOpen) keyword.value = ""
})

function pick(id: string) {
  value.value = id
  open.value = false
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        id="pref-timezone"
        variant="outline"
        role="combobox"
        :aria-expanded="open"
        class="w-[280px] max-w-full justify-between font-normal"
      >
        <span class="truncate">{{ triggerLabel }}</span>
        <ChevronsUpDown class="size-4 shrink-0 opacity-50" />
      </Button>
    </PopoverTrigger>

    <PopoverContent class="w-[320px] p-0" align="end">
      <Command>
        <div class="flex h-9 items-center gap-2 border-b px-3">
          <Search class="size-4 shrink-0 opacity-50" />
          <ListboxFilter
            v-model="keyword"
            auto-focus
            placeholder="搜索：shanghai / 上海 / +8"
            class="flex h-9 w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
          />
        </div>

        <CommandList class="max-h-[300px]">
          <!--
            这里不能用 CommandEmpty：它是按 Command 内建过滤的命中数来显示的，
            而过滤在我们自己手里，它的计数永远是 0 条命中也不亮。
          -->
          <p
            v-if="!items.length && !autoMatches"
            class="py-6 text-center text-sm text-muted-foreground"
          >
            没有匹配的时区
          </p>

          <!-- CommandItem 必须待在 CommandGroup 里（它 inject 的是组上下文） -->
          <CommandGroup v-if="autoMatches">
            <CommandItem :value="AUTO" class="justify-between" @select="pick(AUTO)">
              <span class="truncate">跟随浏览器</span>
              <span class="flex items-center gap-2">
                <span class="text-xs text-muted-foreground">{{ browserZone }}</span>
                <Check :class="cn('size-4', effective === AUTO ? '' : 'opacity-0')" />
              </span>
            </CommandItem>
          </CommandGroup>

          <CommandGroup
            v-if="items.length"
            :heading="keyword.trim() ? '搜索结果' : '常用时区'"
          >
            <CommandItem
              v-for="zone in items"
              :key="zone.id"
              :value="zone.id"
              class="justify-between"
              @select="pick(zone.id)"
            >
              <span class="truncate">{{ zone.id }}</span>
              <span class="flex items-center gap-2">
                <span v-if="showOffset" class="text-xs text-muted-foreground">{{
                  zone.offsetLabel
                }}</span>
                <Check
                  :class="cn('size-4', effective === zone.id ? '' : 'opacity-0')"
                />
              </span>
            </CommandItem>
          </CommandGroup>

          <p
            v-if="!keyword.trim()"
            class="px-3 py-1.5 text-xs text-muted-foreground"
          >
            以上是常用时区，输入关键字可搜索全部
          </p>
          <p
            v-else-if="hiddenCount > 0"
            class="px-3 py-1.5 text-xs text-muted-foreground"
          >
            还有 {{ hiddenCount }} 条没显示，继续输入以缩小范围
          </p>
        </CommandList>

        <!--
          常驻一行当前值：搜索之后选中项多半已经被过滤掉，列表里那个 ✓ 就看不见了。
          「我到底设成了什么」得随时能确认，否则很容易以为自己设过了其实没有。
        -->
        <div
          class="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground"
          data-testid="tz-current"
        >
          <span class="shrink-0">当前：</span>
          <span class="truncate text-foreground">{{ triggerLabel }}</span>
        </div>
      </Command>
    </PopoverContent>
  </Popover>
</template>
