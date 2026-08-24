<script setup lang="ts">
import { computed, ref } from "vue"
import { useRouter } from "vue-router"
import { BookOpen, Search, Settings2 } from "lucide-vue-next"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import BackendNotice from "@/components/galstory/BackendNotice.vue"

import { storyApi, structureLabel } from "@/lib/galstory"
import type { StorySummary } from "@/types/galstory"

/**
 * 故事库 —— GalStory 的入口页。
 *
 * **这一页只列故事模板**，不列存档。两者是两种东西：故事是作者态的模板目录，存档是
 * `<storage>/<story>/<save-id>/`，里面**冻结了模板的一份整副本**（改模板不影响进行中的存档）。
 * 混进同一张表的两个筛选项就会把这条最要紧的语义藏起来 —— 存档挂在各自故事的详情页里。
 *
 * ⚠️ **这里没有故事简介，是刻意的，不是接口没做完**：引擎的选单口除 `title` 外一个字都不给，
 * 因为 `StorySpec` 其余字段「仅导演可见」（里面有 `core_conflict`/`ending`）。要看那些去详情页
 * ——那条口是作者面的。
 *
 * 搜索也在本地做：故事是几个到几十个的量级，一个 `?keyword=` 参数换来的是引擎那一侧多一条
 * 要维护的判据，而它对结果没有任何影响。
 */

const router = useRouter()

const items = ref<StorySummary[]>([])
const loading = ref(true)
const error = ref<unknown>(null)

const keyword = ref("")

async function load() {
  loading.value = true
  error.value = null
  try {
    items.value = await storyApi.list()
  } catch (err) {
    error.value = err
  } finally {
    loading.value = false
  }
}

void load()

const shown = computed(() => {
  const word = keyword.value.trim().toLowerCase()
  if (!word) return items.value
  return items.value.filter(
    (s) => s.name.toLowerCase().includes(word) || s.title.toLowerCase().includes(word)
  )
})
</script>

<template>
  <div class="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 p-6">
    <header class="flex items-start gap-4">
      <div class="flex-1">
        <h1 class="text-2xl font-semibold tracking-tight">故事库</h1>
        <p class="text-sm text-muted-foreground">
          作者态的故事模板。开一局会把模板整份复制进存档，此后改模板不影响进行中的那一局。
        </p>
      </div>
      <Button variant="outline" @click="router.push('/galstory/config')">
        <Settings2 />
        模型配置
      </Button>
    </header>

    <div v-if="loading" class="flex flex-col gap-2">
      <Skeleton v-for="i in 4" :key="i" class="h-14 w-full" />
    </div>

    <BackendNotice v-else-if="error" :error="error" @retry="load()" />

    <template v-else>
      <div class="relative max-w-sm">
        <Search
          class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input v-model="keyword" placeholder="搜索故事名称或 id" class="pl-9" />
      </div>

      <div
        v-if="shown.length === 0"
        class="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center"
      >
        <BookOpen class="size-8 text-muted-foreground" />
        <p class="text-sm text-muted-foreground">
          {{ keyword ? "没有匹配的故事" : "故事目录里还没有故事" }}
        </p>
      </div>

      <div v-else class="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>故事</TableHead>
              <TableHead class="w-32">编制</TableHead>
              <TableHead class="w-20 text-right">角色</TableHead>
              <TableHead class="w-20 text-right">存档</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              v-for="story in shown"
              :key="story.name"
              class="cursor-pointer"
              @click="router.push(`/galstory/stories/${story.name}`)"
            >
              <TableCell>
                <div class="flex items-center gap-2">
                  <span class="font-medium">{{ story.title }}</span>
                  <code class="font-mono text-xs text-muted-foreground">{{ story.name }}</code>
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{{ structureLabel(null, story.scenes) }}</Badge>
              </TableCell>
              <TableCell class="text-right tabular-nums">{{ story.characters }}</TableCell>
              <TableCell class="text-right tabular-nums">{{ story.saves }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </template>
  </div>
</template>
