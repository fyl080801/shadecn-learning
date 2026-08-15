<script setup lang="ts">
import { ref, watch } from "vue"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useFlowEditor } from "@/composables/flow"

/**
 * 右侧属性面板：编辑选中节点的业务数据。
 *
 * 面板只会调 `selection.updateNodeData()` —— 它负责算出 before/after 并
 * 交给 store.apply，所以这里改出来的东西一样能撤销、一样会落库。
 */
const { selection } = useFlowEditor()
const { selectedNode, updateNodeData } = selection

const configText = ref("")
const configError = ref<string | null>(null)

// 换选中节点时重新灌一次 JSON 文本
watch(
  selectedNode,
  (node) => {
    configText.value = node ? JSON.stringify(node.data.config, null, 2) : ""
    configError.value = null
  },
  { immediate: true }
)

/** config 本期用 JSON 编辑器兜底：服务端只透传，不解释内容 */
function commitConfig() {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(configText.value || "{}") as Record<string, unknown>
  } catch (err) {
    configError.value = err instanceof Error ? err.message : "不是合法的 JSON"
    return
  }
  configError.value = null
  updateNodeData({ config: parsed }, "修改节点配置")
}
</script>

<template>
  <aside
    v-if="selectedNode"
    class="absolute right-0 top-0 z-10 flex h-full w-80 flex-col gap-4 overflow-auto border-l bg-card/95 p-4 backdrop-blur"
  >
    <div class="space-y-2">
      <Label for="node-label">标题</Label>
      <Input
        id="node-label"
        :model-value="selectedNode.data.label"
        @change="
          updateNodeData({ label: ($event.target as HTMLInputElement).value }, '修改节点标题')
        "
      />
    </div>

    <div class="space-y-2">
      <Label for="node-desc">说明</Label>
      <Textarea
        id="node-desc"
        rows="3"
        :model-value="selectedNode.data.description ?? ''"
        @change="
          updateNodeData(
            { description: ($event.target as HTMLTextAreaElement).value },
            '修改节点说明'
          )
        "
      />
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-2">
      <Label for="node-config">
        自定义配置（JSON）
        <span class="font-normal text-muted-foreground">· kind: {{ selectedNode.data.kind }}</span>
      </Label>
      <Textarea
        id="node-config"
        v-model="configText"
        class="min-h-40 flex-1 font-mono text-xs"
        spellcheck="false"
        @blur="commitConfig"
      />
      <p v-if="configError" class="text-xs text-destructive">{{ configError }}</p>
      <p v-else class="text-xs text-muted-foreground">
        结构自定，服务端只负责原样存取。失焦即保存。
      </p>
    </div>
  </aside>
</template>
