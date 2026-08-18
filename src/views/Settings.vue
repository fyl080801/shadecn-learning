<script setup lang="ts">
import { computed } from "vue"
import { useNow } from "@vueuse/core"
import {
  Monitor,
  Moon,
  RotateCcw,
  Sun,
  TriangleAlert,
  User as UserIcon
} from "lucide-vue-next"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import TimeZonePicker from "@/components/settings/TimeZonePicker.vue"

import { useAuth } from "@/lib/auth"
import { formatDate, formatDateTime, formatTime, formatWith } from "@/lib/format"
import {
  AUTO,
  DATE_STYLE_OPTIONS,
  HOUR_CYCLE_OPTIONS,
  LOCALE_OPTIONS,
  TIME_STYLE_OPTIONS,
  browserLocale,
  displayPreferences,
  effectiveLocale,
  effectiveTimeZone,
  intlTimeZoneReliable,
  localeHour12,
  offsetLabelOf,
  useDisplayPreferences
} from "@/lib/preferences"
import {
  THEME_AUTO,
  THEME_OPTIONS,
  type ThemePreference,
  systemTheme,
  theme
} from "@/lib/theme"

/**
 * 设置页。三块内容：
 *   - 当前用户：只读，来自 /api/auth/me（前端没有 token，这里能看到的就是全部）
 *   - 外观：深色 / 浅色 / 跟随系统
 *   - 日期显示：时区 / 语言 / 格式，存在这台浏览器的 localStorage 里，默认跟随浏览器
 * 后两块都是本机偏好，改动即时生效 —— 偏好是响应式的（主题直接改 `<html>` 的类，
 * 时间全站走 `@/lib/format`），所以没有「保存」按钮。
 */

const { user, displayName, isAuthenticated, authEnabled } = useAuth()
const { preferences, reset } = useDisplayPreferences()

/** 每秒走一次，让下面的预览是活的 —— 换个时区能直接看出差几小时 */
const now = useNow({ interval: 1000 })

/**
 * 下拉里的示例用一个**固定**时刻算，不跟着 now 走 —— 否则展开的列表里
 * 秒数一直在跳。示例本身跟着偏好走（`formatWith` 会把当前时区/时制填进去），
 * 所以「短/中/长/完整」写的就是它真正会显示成的样子。
 */
const sampleAt = new Date()

const dateStyleOptions = computed(() =>
  DATE_STYLE_OPTIONS.map((option) => ({
    ...option,
    sample: formatWith(sampleAt, { dateStyle: option.value })
  }))
)

const timeStyleOptions = computed(() =>
  TIME_STYLE_OPTIONS.map((option) => ({
    ...option,
    sample: formatWith(sampleAt, { timeStyle: option.value })
  }))
)

/** 浏览器扩展有没有把 Intl 换掉；换掉了的话时区设置在这台浏览器上不起作用 */
const intlReliable = intlTimeZoneReliable()

/** 当前实际生效的那一套，写在预览上方，方便自己核对 */
const activeTimeZone = computed(() => effectiveTimeZone())
const activeOffset = computed(() => offsetLabelOf(activeTimeZone.value))
const activeLocale = computed(() => effectiveLocale())
const browserHourCycleLabel = computed(() =>
  localeHour12(activeLocale.value) ? "12 小时制" : "24 小时制"
)

const isDefault = computed(() => {
  const p = displayPreferences.value
  return (
    p.locale === AUTO &&
    p.timeZone === AUTO &&
    p.dateStyle === "short" &&
    p.timeStyle === "short" &&
    p.hourCycle === AUTO
  )
})

const THEME_ICONS: Record<ThemePreference, typeof Sun> = {
  light: Sun,
  dark: Moon,
  auto: Monitor
}

/** 「跟随系统」此刻跟到了哪一档，写在括号里 —— 否则选了它看不出结果是什么 */
const systemThemeLabel = computed(() =>
  systemTheme.value === "dark" ? "深色" : "浅色"
)

const userFields = computed(() => [
  { label: "显示名", value: user.value?.name ?? displayName.value },
  { label: "用户名", value: user.value?.username },
  { label: "邮箱", value: user.value?.email }
])
</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-6 p-6">
    <div>
      <h1 class="text-2xl font-bold">设置</h1>
      <p class="text-sm text-muted-foreground">账号信息与本机的显示偏好</p>
    </div>

    <!-- 当前用户 -->
    <Card>
      <CardHeader>
        <CardTitle>当前用户</CardTitle>
        <CardDescription>
          {{
            authEnabled
              ? "来自单点登录，这里只读；要改请到账号中心"
              : "后端未启用鉴权，当前是本地开发用户"
          }}
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <div v-if="isAuthenticated" class="flex items-center gap-3">
          <!-- 默认头像是透明底的像素图案，底下垫一层圆背景，形状才和无头像时那个圆一致 -->
          <img
            v-if="user?.avatarUrl"
            :src="user.avatarUrl"
            alt=""
            class="size-12 shrink-0 rounded-full bg-muted object-cover"
          />
          <span
            v-else
            class="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <UserIcon class="size-6" />
          </span>
          <div class="min-w-0 flex-1">
            <!--
              用户 ID 只是个标识符，放头像这一行的右边就够了，不占下面的字段位。
              它和显示名同在一个 `items-baseline` 的行里 —— 两边字号不同，只有
              按基线对齐才是真的齐；靠 `self-start` 对的是行盒顶边，会差两三像素。
            -->
            <div class="flex items-baseline gap-3">
              <p class="truncate font-medium">{{ displayName }}</p>
              <p
                class="ml-auto min-w-0 truncate text-sm text-muted-foreground"
                data-testid="user-id"
                :title="user?.id ?? ''"
              >
                ID: {{ user?.id || "-" }}
              </p>
            </div>
            <p class="truncate text-sm text-muted-foreground">
              {{ user?.email ?? "未提供邮箱" }}
            </p>
          </div>
        </div>
        <p v-else class="text-sm text-muted-foreground">当前没有登录用户。</p>

        <template v-if="isAuthenticated">
          <Separator />
          <dl class="grid gap-3 sm:grid-cols-2">
            <div v-for="field in userFields" :key="field.label" class="min-w-0">
              <dt class="text-xs text-muted-foreground">{{ field.label }}</dt>
              <dd class="truncate text-sm">{{ field.value || "-" }}</dd>
            </div>
          </dl>
        </template>
      </CardContent>
    </Card>

    <!-- 外观 -->
    <Card>
      <CardHeader>
        <CardTitle>外观</CardTitle>
        <CardDescription>
          只影响这台浏览器，改完立即生效。默认跟随系统。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label>主题</Label>
          <!--
            三档并排，不用 Select：选项只有三个，且每一档都有直观的图标 ——
            展开一层下拉才能换主题，比直接点一下慢。
          -->
          <div class="flex gap-2" role="radiogroup" aria-label="主题">
            <Button
              v-for="option in THEME_OPTIONS"
              :key="option.value"
              :variant="theme === option.value ? 'default' : 'outline'"
              size="sm"
              role="radio"
              :aria-checked="theme === option.value"
              :data-testid="`theme-${option.value}`"
              @click="theme = option.value"
            >
              <component :is="THEME_ICONS[option.value]" class="size-4" />
              {{ option.label }}
            </Button>
          </div>
        </div>
        <p
          v-if="theme === THEME_AUTO"
          class="mt-2 text-xs text-muted-foreground"
          data-testid="theme-system-hint"
        >
          跟随系统设置，当前是{{ systemThemeLabel }}。
        </p>
      </CardContent>
    </Card>

    <!-- 日期显示 -->
    <Card>
      <CardHeader>
        <CardTitle>日期与时间显示</CardTitle>
        <CardDescription>
          只影响这台浏览器上的显示，改完立即生效。默认全部跟随浏览器。
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <!--
          Intl 被劫持时这里做什么都没用，必须直说 —— 否则表现出来就是
          「设了时区没反应」，看着像应用坏了。
        -->
        <div
          v-if="!intlReliable"
          class="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          data-testid="intl-warning"
        >
          <TriangleAlert class="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div class="space-y-1">
            <p class="font-medium">时区设置在这个浏览器里不会生效</p>
            <p class="text-muted-foreground">
              检测到页面里的 <code>Intl.DateTimeFormat</code>
              被改过：传给它的时区参数被忽略了，所有时间都会按同一个时区显示。
              通常是「强制修改时区」这类浏览器扩展造成的 ——
              关掉它（或把本站加进它的排除名单）之后这里的设置才有意义。
            </p>
          </div>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label for="pref-timezone">时区</Label>
          <!-- 四百多个时区，只能搜，不能滚 —— 单独一个能打关键字的下拉 -->
          <TimeZonePicker v-model="preferences.timeZone" />
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label for="pref-locale">语言（决定年月日的顺序和分隔符）</Label>
          <Select v-model="preferences.locale">
            <SelectTrigger id="pref-locale" class="w-[280px] max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="AUTO">
                跟随浏览器（{{ browserLocale() }}）
              </SelectItem>
              <SelectItem
                v-for="option in LOCALE_OPTIONS"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label for="pref-date-style">日期格式</Label>
          <Select v-model="preferences.dateStyle">
            <SelectTrigger id="pref-date-style" class="w-[280px] max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="option in dateStyleOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}（{{ option.sample }}）
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label for="pref-time-style">时间格式</Label>
          <Select v-model="preferences.timeStyle">
            <SelectTrigger id="pref-time-style" class="w-[280px] max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="option in timeStyleOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}（{{ option.sample }}）
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label for="pref-hour-cycle">时制</Label>
          <Select v-model="preferences.hourCycle">
            <SelectTrigger id="pref-hour-cycle" class="w-[280px] max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="option in HOUR_CYCLE_OPTIONS"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label
                }}<template v-if="option.value === AUTO">（{{
                  browserHourCycleLabel
                }}）</template>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Separator />

        <div class="space-y-2">
          <!--
            标注按哪个时区、哪个语言渲染的 —— 不写出来的话，一旦时间和自己
            电脑上的对不上，没人分得清是「设置没生效」还是「本来就该差这几个小时」。
          -->
          <!-- Intl 不可信时偏移是插件算出来的假值，不如不写 -->
          <p class="text-xs text-muted-foreground" data-testid="preview-basis">
            预览（当前时刻，按 {{ activeTimeZone
            }}<template v-if="intlReliable">（{{ activeOffset }}）</template> ·
            {{ activeLocale }} 显示）
          </p>
          <dl class="grid gap-2 sm:grid-cols-3" data-testid="preview">
            <div>
              <dt class="text-xs text-muted-foreground">日期 + 时间</dt>
              <dd class="text-sm font-medium" data-testid="preview-datetime">
                {{ formatDateTime(now) }}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">只到天</dt>
              <dd class="text-sm font-medium" data-testid="preview-date">
                {{ formatDate(now) }}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">只到时刻</dt>
              <dd class="text-sm font-medium" data-testid="preview-time">
                {{ formatTime(now) }}
              </dd>
            </div>
          </dl>
        </div>

        <div class="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            :disabled="isDefault"
            @click="reset()"
          >
            <RotateCcw class="size-4" />
            恢复默认
          </Button>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
