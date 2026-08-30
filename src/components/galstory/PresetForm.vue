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

import { configApi } from "@/lib/galstory"
import { diffPatch, numberOrKeep, numberOrNull } from "@/lib/galstory-form"
import { useAsyncAction } from "@/composables/useAsyncAction"
import type { ModelConfig, Preset, PresetPatch } from "@/types/galstory"

/**
 * 一个采样预设。
 *
 * **与连接是两件事**：连接管「谁提供、卡多久算卡住」，预设管「怎么采样」——
 * 同一条连接可以被几个不同温度的环节共用，故它们各是一份可寻址的东西。
 *
 * 三个 `null` 的字段（`topP`/`topK`/`maxTokens`）**清空就是清空**：值为 null 时引擎不把这个
 * 参数发给端点，那与「发一个 0」完全不是一回事。
 */

const props = defineProps<{
  preset: Preset | null
  creating: boolean
  config: ModelConfig
}>()

const emit = defineEmits<{ saved: [config: ModelConfig]; close: [] }>()

/**
 * 数字框的草稿类型是 `number | string`，**空框就是空串**（shadcn 的 Input 不收 null）。
 * 提交时再按「这一格可不可以为空」分流：`numberOrNull` 把空串变成显式 null（清掉这一项），
 * `numberOrKeep` 把空串还原成原值（这一格不允许空，用户只是把框清了）。
 */
interface Draft {
  id: string
  temperature: number | string
  topP: number | string
  topK: number | string
  maxTokens: number | string
}

const draft = ref<Draft>(blank())

function blank(): Draft {
  return { id: "", temperature: 1, topP: "", topK: "", maxTokens: "" }
}

const open = computed(() => props.preset !== null || props.creating)

watch(
  () => [props.preset, props.creating] as const,
  ([preset, creating]) => {
    if (preset)
      draft.value = {
        id: preset.id,
        temperature: preset.temperature,
        topP: preset.topP ?? "",
        topK: preset.topK ?? "",
        maxTokens: preset.maxTokens ?? ""
      }
    else if (creating) draft.value = blank()
  },
  { immediate: true }
)

const ID_RE = /^[A-Za-z0-9_.-]+$/

const { run: submit, pending } = useAsyncAction(async () => {
  const id = draft.value.id.trim()
  if (!id) {
    toast.error("请填写预设 id")
    return
  }
  if (!ID_RE.test(id)) {
    toast.error("预设 id 只能用字母、数字、下划线、点和短横线")
    return
  }
  if (props.creating && props.config.presets.some((p) => p.id === id)) {
    toast.error(`已经有一个叫「${id}」的预设了`)
    return
  }

  const original = props.preset
  const patch: PresetPatch = diffPatch<PresetPatch>(
    {
      // temperature 不可为空：框清空了保持原值，别发 null
      temperature: numberOrKeep(draft.value.temperature, original?.temperature ?? 1),
      // 这三个可为空，清空 = 不把这个参数发给端点
      topP: numberOrNull(draft.value.topP),
      topK: numberOrNull(draft.value.topK),
      maxTokens: numberOrNull(draft.value.maxTokens)
    },
    original === null
      ? null
      : {
          temperature: original.temperature,
          topP: original.topP,
          topK: original.topK,
          maxTokens: original.maxTokens
        }
  )

  if (original !== null && Object.keys(patch).length === 0) {
    toast.info("没有改动")
    emit("close")
    return
  }

  const result = await configApi.savePreset(id, patch)
  toast.success(result.created ? `预设「${id}」已创建` : `预设「${id}」已保存`)
  emit("saved", result.config)
}, { errorMessage: "保存失败" })
</script>

<template>
  <Dialog :open="open" @update:open="(next) => !next && emit('close')">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ creating ? "新建采样预设" : `编辑预设 ${draft.id}` }}</DialogTitle>
        <DialogDescription>
          留空的参数不会发给端点 —— 那与发一个 0 完全不是一回事。
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-4">
        <div class="space-y-2">
          <Label for="preset-id">id</Label>
          <Input
            id="preset-id"
            v-model="draft.id"
            :disabled="!creating"
            placeholder="例如：judge_local"
          />
          <p v-if="!creating" class="text-xs text-muted-foreground">
            id 不能改：指着它的那几个环节要跟着改，那是「删一个建一个」。
          </p>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-2">
            <Label for="preset-temp">temperature</Label>
            <Input id="preset-temp" v-model="draft.temperature" type="number" step="0.1" />
          </div>

          <div class="space-y-2">
            <Label for="preset-max-tokens">max_tokens</Label>
            <Input
              id="preset-max-tokens"
              v-model="draft.maxTokens"
              type="number"
              step="512"
              placeholder="留空 = 不限"
            />
          </div>

          <div class="space-y-2">
            <Label for="preset-top-p">top_p</Label>
            <Input
              id="preset-top-p"
              v-model="draft.topP"
              type="number"
              step="0.05"
              placeholder="留空 = 不发"
            />
          </div>

          <div class="space-y-2">
            <Label for="preset-top-k">top_k</Label>
            <Input
              id="preset-top-k"
              v-model="draft.topK"
              type="number"
              step="1"
              placeholder="留空 = 不发"
            />
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="pending" @click="emit('close')">取消</Button>
        <Button :loading="pending" @click="submit()">保存</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
