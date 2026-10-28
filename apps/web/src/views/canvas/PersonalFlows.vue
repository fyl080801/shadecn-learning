<script setup lang="ts">
import { ref } from "vue"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

import FlowList from "@/components/canvas/FlowList.vue"
import { projectApi } from "@/lib/api"
import { useAsyncAction } from "@/composables/useAsyncAction"

/**
 * 个人画布 —— 只有自己看得到、也不走协同的那一批（REQ-SOLO）。
 *
 * 和项目**分成两个页面、两个侧栏入口**：它们是两种东西，不是一个列表的两个筛选项。
 * 项目那边点进去还有一层（成员、分享），个人画布点进去就是画布本身。
 *
 * 个人空间在接口层面就是个 `kind='personal'` 的项目，所以列表整个交给 `FlowList`
 * ——和项目主页的画布 Tab 是同一个组件，这里只负责把 id 取出来。
 *
 * **`GET /api/projects/personal` 是个「读也会建」的接口**：空间是懒创建的，
 * 挂在这个页面上就意味着没来过这一页的人不会被凭空建出一个空间。
 */

const personalId = ref<string | null>(null)
const personalError = ref<string | null>(null)
const total = ref(0)

const { run: loadPersonal, pending: loading } = useAsyncAction(async () => {
  personalError.value = null
  try {
    personalId.value = (await projectApi.personal()).id
  } catch (err) {
    personalError.value = err instanceof Error ? err.message : String(err)
  }
})

void loadPersonal()
</script>

<template>
  <div class="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 p-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">个人画布</h1>
      <p class="text-sm text-muted-foreground">
        只有你自己看得到，不走协同 —— 需要和别人一起画就建到项目里。
      </p>
    </header>

    <div v-if="loading" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-12 w-full" />
    </div>

    <div
      v-else-if="personalError"
      class="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center"
    >
      <p class="text-sm text-destructive">{{ personalError }}</p>
      <Button variant="outline" size="sm" @click="loadPersonal()">重试</Button>
    </div>

    <!-- 这一页只有这一个列表，所以页码 / 关键字写进 URL；刷新、分享链接都能停在原处 -->
    <FlowList
      v-else-if="personalId"
      v-model:total="total"
      :project-id="personalId"
      sync-query
      empty-hint="这里只有你自己看得到 —— 新建一张画布试试"
    />
  </div>
</template>
