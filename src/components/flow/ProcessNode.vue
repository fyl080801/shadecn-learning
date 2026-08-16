<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import { Handle, Position, type NodeProps } from "@vue-flow/core"
import { NodeToolbar } from "@vue-flow/node-toolbar"

import FlowPresenceAvatar from "@/components/flow/FlowPresenceAvatar.vue"
import { useFlowEditor } from "@/composables/flow"

export interface ProcessNodeData {
  label: string
}

const props = defineProps<NodeProps<ProcessNodeData>>()

const { presence, selection, store } = useFlowEditor()

/**
 * 别人占着这个节点：黄框 + 只读。
 *
 * 「占用」的判据是**他是不是正在改这个节点**，所以只读也只挡改它的操作：
 * 不能选、不能拖、不能删、不能改标题。
 *
 * **连线口两头都保持开放** —— 从它拉出一条线、把线接到它上面，动的都是**新的边**，
 * 节点本身没变，不该被占用挡住（`docs/04-realtime-collab.md` §4.0.1）。
 * 真正受保护的是**已经接在它上面的那些边**：别人在编辑它的时候不能把线拆掉，
 * 这条派生占用由 `useFlowCanvas` 算（只有画布知道谁连着谁）。
 *
 * 通用的只读位（不能选、不能拖）由 `useFlowCanvas` 统一写在节点数据上，节点和边一视同仁；
 * `nodrag` 是保险：即使某次节点数据没同步到，手势也拖不动它。
 */
const lockedBy = computed(() => presence.lockOf("node", props.id))

/** 远端占着这个节点的人，名字边上露头像用（一般就一个） */
const occupants = computed(() => presence.occupantsOf("node", props.id))

// —— 就地改标题 ——

const editing = ref(false)
const draft = ref("")
const inputRef = ref<HTMLInputElement | null>(null)

/**
 * 双击标题就地改名。
 *
 * 先 `select(id)`：改标题就是在编辑这个节点，得先把它占住，别人才看得到「有人在动它」
 * （选中即占用，见 §4.0.1）。别人占着时直接不给进编辑态。
 */
async function startEdit() {
  if (lockedBy.value) return
  selection.select(props.id)
  draft.value = props.data.label
  editing.value = true
  await nextTick()
  inputRef.value?.focus()
  inputRef.value?.select()
}

/**
 * 提交改名。走 `store.apply` 而不是直接改 `data` —— 这样它才进历史、才落库、
 * 才会广播给别人（数据层的铁律）。名字没变或被清空就当没改过。
 */
function commitEdit() {
  if (!editing.value) return
  editing.value = false

  const next = draft.value.trim()
  if (!next || next === props.data.label) return

  store.apply(
    [
      {
        type: "node.update",
        targetId: props.id,
        before: { data: { label: props.data.label } },
        after: { data: { label: next } }
      }
    ],
    "修改节点标题"
  )
}

function cancelEdit() {
  editing.value = false
}

/**
 * 编辑到一半被别人抢走（他的 clientId 更小）：把输入框收掉，改的东西不提交。
 * 提交了也是白提交 —— 那一刻这个节点已经不归我了。
 */
watch(lockedBy, (locked) => {
  if (locked) editing.value = false
})
</script>

<template>
  <div
    class="relative min-h-12 min-w-32 rounded-md border bg-card px-3 py-2 text-sm text-card-foreground shadow-sm transition-shadow"
    :class="
      lockedBy
        ? // 黄色阴影框 = 这个节点归别人了，我这边只能看。nodrag 是 Vue Flow 的约定类名，
          // 挂上它这个节点就拖不动了
          'nodrag !cursor-not-allowed border-amber-400 ring-2 ring-amber-400 shadow-[0_0_0_6px_rgba(250,204,21,0.25)]'
        : selected
          ? 'border-primary shadow-md ring-2 ring-primary/40'
          : ''
    "
  >
    <!--
      节点名挂在节点外部左上角：定位交给 Vue Flow 官方的 NodeToolbar
      （position=Top + align=start），缩放/拖动时的跟随由它负责，这里不写定位样式。
      is-visible 常开，否则默认只在节点被选中时出现。
    -->
    <NodeToolbar :is-visible="true" :position="Position.Top" align="start" :offset="4">
      <div class="flex items-center gap-1.5">
        <!-- nodrag / nopan：在输入框里拖选文字不该变成拖节点或拖画布 -->
        <input
          v-if="editing"
          ref="inputRef"
          v-model="draft"
          class="nodrag nopan h-5 w-32 rounded border border-primary bg-card px-1 text-xs outline-none"
          @blur="commitEdit"
          @keydown.enter.prevent="commitEdit"
          @keydown.esc.prevent="cancelEdit"
          @dblclick.stop
        />
        <span
          v-else
          class="text-xs font-medium text-muted-foreground"
          :class="lockedBy ? 'cursor-not-allowed' : 'cursor-text hover:text-foreground'"
          :title="lockedBy ? `${lockedBy.user.name} 正在编辑` : '双击改名'"
          @dblclick.stop="startEdit"
        >
          {{ data.label }}
        </span>

        <!-- 谁占着它就贴谁的头像 + 名字，颜色和那个人的光标一致 -->
        <span
          v-for="peer in occupants"
          :key="peer.clientId"
          class="flex items-center gap-1 rounded-full py-[2px] pl-[2px] pr-1.5 text-[10px] font-medium leading-none text-white shadow-sm"
          :style="{ backgroundColor: peer.user.color }"
        >
          <FlowPresenceAvatar :user="peer.user" class="size-3.5" />
          {{ peer.user.name }}
        </span>
      </div>
    </NodeToolbar>

    <!--
      两个连接口都不受占用影响：连线创建的是新的边，不修改这个节点。
      能不能连是 Vue Flow 的全局设定，这里不再按占用关闭。
    -->
    <Handle
      type="target"
      :position="Position.Left"
      class="!size-2.5 !border-2 !border-background !bg-primary"
    />

    <Handle
      type="source"
      :position="Position.Right"
      class="!size-2.5 !border-2 !border-background !bg-primary"
    />
  </div>
</template>
