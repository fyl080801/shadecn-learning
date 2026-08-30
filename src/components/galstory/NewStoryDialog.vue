<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { toast } from "vue-sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { useAsyncAction } from "@/composables/useAsyncAction"
import { storyApi } from "@/lib/galstory"
import type { StorySummary } from "@/types/galstory"

/**
 * 新建一个属于我的故事：**空骨架**，或**从一个现成故事复制**。
 *
 * ⚠️ **「复制成我的」与「开始玩一局」是两个动作，别在界面上合成一个入口**：那个产出
 * **存档**（模板整份冻结进 `<save>/story/`，玩的是副本），这个产出**模板**（可以接着改）。
 * 合成一个之后「我想改改这个故事」就没地方去了 —— 这条判据在引擎那一侧也是明写的。
 *
 * ⚠️ **空骨架是「能直接跑起来的最小一份」**，不是一份空模板：建完就是红的话，作者第一眼
 * 看到的是四条错误而不是一个能玩的东西。故这里建完就直接进编辑页，不需要先去修什么。
 */

const props = defineProps<{
  open: boolean
  /** 非空 = 从这个故事复制一份。空 = 建一份空骨架 */
  from: StorySummary | null
}>()

const emit = defineEmits<{
  close: []
  created: [story: StorySummary]
}>()

const title = ref("")

const copying = computed(() => props.from !== null)

// 打开时给一个合理的初值：复制那条路默认叫「XX（副本）」，人多半只想改几个字
watch(
  () => props.open,
  (open) => {
    if (!open) return
    title.value = props.from ? `${props.from.title}（副本）` : ""
  }
)

const { run: submit, pending } = useAsyncAction(
  async () => {
    const name = title.value.trim()
    if (!name) {
      toast.error("给它起个名字")
      return
    }
    const story = await storyApi.create(name, props.from?.name ?? "")
    toast.success(copying.value ? `已复制成《${story.title}》` : `已新建《${story.title}》`)
    emit("created", story)
  },
  { errorMessage: "新建失败" }
)
</script>

<template>
  <Dialog :open="open" @update:open="(v) => !v && emit('close')">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ copying ? `复制《${from?.title}》` : "新建故事" }}</DialogTitle>
        <DialogDescription>
          <template v-if="copying">
            连同角色、知识与它自带的插件整份复制到「我的故事」，此后两份互不影响 ——
            原来那份一个字都不会动。
          </template>
          <template v-else>
            会铺一份能直接跑起来的最小骨架（一个角色、一段开场），建完就能开局，
            也可以先去编辑页把它改成你要的样子。
          </template>
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-2">
        <Label for="new-story-title">标题</Label>
        <Input
          id="new-story-title"
          v-model="title"
          placeholder="例如：雨夜旅店"
          autofocus
          @keydown.enter.prevent="submit()"
        />
        <!-- ⚠️ id 由引擎发（时间戳 + 随机后缀），**不拿标题当目录名**：标题是中文/emoji，
             当目录名要处理一堆文件系统差异，而且改标题就得迁移目录。 -->
        <p class="text-xs text-muted-foreground">
          标题随时可改；故事的 id 由引擎生成，改标题不会换 id。
        </p>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('close')">取消</Button>
        <Button :loading="pending" @click="submit()">
          {{ copying ? "复制" : "新建" }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
