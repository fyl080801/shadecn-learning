<script setup lang="ts">
/**
 * 画布导演台节点全屏打开后的舞台（docs/07 §2.1、§7.6）：视口 + 最小编辑界面 + 时间轴。
 *
 * **节点 `data` 里的 `dc.*` 是唯一的事实源**，视口里的 three 场景是它的投影（`directorProjection.ts`）：
 * - 对账：数据一变按对象 id 增量建 / 改 / 删 Object3D，只动变了的；
 * - 求值：位置 / 旋转 / 缩放 / fov 一律是 `objectStateAt(时间线, id, 播放头)`，播放、拖播放头、数据变了都只是重新求值，
 *   **不写 doc**，也不用 AnimationMixer；
 * - 写：添加图形、删除、gizmo 松手、打关键帧，一律经 `useDirectorNode` → `store.mutateDirector` → shared 的导演台 ops。
 *   three-editor 自带的 Command / History 不是数据源（引擎在 gizmo 松手时照样往 `editor.history` 里记一条，没人读它）。
 *
 * 选区只在本地（`editor.selected`，本期不进 awareness）。
 *
 * 键盘不在这里监听：全屏层（`FlowDirectorOverlay`）统一路由，按到导演台自己的快捷键时调 `runShortcut`。
 *
 * 编辑器实例随组件创建、随组件卸载销毁（EditorViewport 卸载时 dispose renderer），反复打开关闭不累积 WebGL 上下文。
 *
 * 取景框（画幅叠加层）本期不显示（`dc.aspect` 照样存、照样给 agent 测量用）。
 */
import * as THREE from "three"
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import { toast } from "vue-sonner"
import { Box, Circle, Cone, Cylinder, Lightbulb, Plus, Redo2, Square, Star, Trash2, Undo2, Video } from "@lucide/vue"
import {
  DC_KEYFRAME_PREFIX,
  DC_OBJECT_PREFIX,
  DC_TRACK_PREFIX,
  DIRECTOR_KIND_LABELS,
  type DirectorKeyframe,
  type DirectorObjectKind
} from "@shadecn/shared/director-doc"

import { createEditor, EditorViewport, ThreeEditor } from "@/components/three-editor"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { useFlowEditor } from "@/composables/flow/editor-context"
import { useDirectorNode } from "@/composables/flow/useDirectorNode"
import { useAsyncAction } from "@/composables/useAsyncAction"
import DirectorTimeline from "./DirectorTimeline.vue"
import DirectorTransformControls from "./DirectorTransformControls.vue"
import DirectorViewHelper from "./DirectorViewHelper.vue"
import { bindDirectorGizmoCommit } from "./directorGizmoCommit"
import { resetDirectorGizmoOwner } from "./directorGizmoOwner"
import { createDirectorProjection, directorIdOf } from "./directorProjection"
import { resetDirectorSelection } from "./directorSelection"
import type { DirectorShortcut } from "./directorShortcuts"
import { useCameraFrustumFootprint } from "./useCameraFrustumFootprint"
import { useCameraModelVisibility } from "./useCameraModelVisibility"
import { useDirectorCameraControls } from "./useDirectorCameraControls"
import { useDirectorObjectGizmo } from "./useDirectorObjectGizmo"
import { useDirectorPlayback } from "./useDirectorPlayback"
import { useDirectorRenderer } from "./useDirectorRenderer"
import { useDirectorSceneBackdrop } from "./useDirectorSceneBackdrop"
import { selectDirectorObject, useDirectorSelection } from "./useDirectorSelection"
import { useDirectorShapeMaterial } from "./useDirectorShapeMaterial"

const props = defineProps<{
  nodeId: string
  /**
   * 有绑定这个节点的 agent 任务在跑。为真时远端来的改动短暂高亮 —— 分不清改动来自 agent 还是同伴，
   * 所以近似成「有绑定本节点的任务在跑时的远端改动」（docs/07 §7.5）
   */
  agentEditing?: boolean
}>()

const { store } = useFlowEditor()
const director = useDirectorNode(store, props.nodeId)

// 独立 namespace：Config 按它把渲染设置等写进 localStorage，不与 /3d-viewport 串。
const editor = createEditor("director-stage")

// 选区与调节器归属是模块级单例：上一次打开时停在某个对象上的话，它的 uuid 在新场景里不存在
resetDirectorSelection()
resetDirectorGizmoOwner()

useDirectorSelection(editor)
useDirectorObjectGizmo(editor)
useDirectorShapeMaterial(editor)
useCameraModelVisibility(editor)
useDirectorSceneBackdrop(editor)
useCameraFrustumFootprint(editor)
useDirectorCameraControls(editor)

// —— 投影 ——

const projection = createDirectorProjection({
  add: (object) => editor.addObject(object),
  remove: (object) => {
    if (editor.selected === object) editor.deselect()
    editor.removeObject(object)
  },
  changed: (object) => editor.signals.objectChanged.dispatch(object)
})

/** 正被本地 gizmo 拖着的对象：求值跳过它（草稿占着屏幕） */
const dragging = new Set<THREE.Object3D>()
let ready = false

function applyFrame(t = playback.playhead.value) {
  if (!ready) return
  projection.applyStateAt(director.timeline.value, t, dragging)
  // 一次重绘（选中框、视锥跟着走），不逐个派发 objectChanged
  editor.signals.sceneAnimated.dispatch()
}

function syncScene() {
  if (!ready) return
  projection.reconcile(director.scene.value)
  applyFrame()
}

const playback = useDirectorPlayback({
  duration: computed(() => director.scene.value.duration),
  fps: computed(() => director.scene.value.fps),
  onFrame: (t) => applyFrame(t)
})

watch(director.scene, syncScene)

// —— 选区（本地） ——

const selectedId = ref<string | null>(null)
const selectedKeyframe = shallowRef<DirectorKeyframe | null>(null)
const selectedObject = computed(() => (selectedId.value ? director.scene.value.objects.get(selectedId.value) ?? null : null))

function onObjectSelected(object: THREE.Object3D | null) {
  selectedId.value = directorIdOf(object)
  // 选中的关键帧不属于新选中的对象：一并取消（Delete 删什么要和看到的选中一致）
  const keyframe = selectedKeyframe.value
  const owner = keyframe ? director.scene.value.tracks.get(keyframe.trackId)?.objectId : null
  if (keyframe && owner !== selectedId.value) selectedKeyframe.value = null
}

function selectObject(id: string) {
  const object = projection.objectOf(id)
  if (object) selectDirectorObject(editor, object)
}

function selectKeyframe(keyframe: DirectorKeyframe) {
  selectedKeyframe.value = keyframe
  const track = director.scene.value.tracks.get(keyframe.trackId)
  if (track) selectObject(track.objectId)
  playback.pause()
  playback.seek(keyframe.t)
}

// 选中的关键帧被删了（撤销、别人删）就清掉
watch(director.scene, (scene) => {
  if (selectedKeyframe.value && !scene.keyframes.has(selectedKeyframe.value.id)) selectedKeyframe.value = null
})

// —— 写入 ——

const SHAPE_ITEMS: { kind: DirectorObjectKind; icon: typeof Box }[] = [
  { kind: "box", icon: Box },
  { kind: "sphere", icon: Circle },
  { kind: "cone", icon: Cone },
  { kind: "cylinder", icon: Cylinder },
  { kind: "plane", icon: Square },
  { kind: "camera", icon: Video },
  { kind: "light", icon: Lightbulb }
]

const { run: addObject, pending: adding } = useAsyncAction(
  (kind: DirectorObjectKind) => {
    const id = director.addObject({ kind })
    // 对账在下一拍（scene 的 watch）；选中它要等它入场
    if (id) queueMicrotask(() => selectObject(id))
  },
  { errorMessage: "添加失败" }
)

const { run: removeSelection, pending: removing } = useAsyncAction(
  () => {
    const keyframe = selectedKeyframe.value
    if (keyframe) {
      director.deleteElements({ keyframeIds: [keyframe.id] })
      selectedKeyframe.value = null
      return
    }
    if (selectedId.value) director.deleteElements({ objectIds: [selectedId.value] })
  },
  { errorMessage: "删除失败" }
)

const { run: keyframeSelected, pending: keyframing } = useAsyncAction(
  () => {
    if (!selectedId.value) return
    playback.pause()
    director.keyframeAt(selectedId.value, playback.playhead.value)
  },
  { errorMessage: "打关键帧失败" }
)

const { run: setActiveShot, pending: settingShot } = useAsyncAction(
  () => {
    if (selectedObject.value?.kind !== "camera") return
    director.setSettings({ activeShot: selectedObject.value.id })
  },
  { errorMessage: "设置当前机位失败" }
)

function undo() {
  director.history?.undo()
}
function redo() {
  director.history?.redo()
}

/** 全屏层路由过来的快捷键 */
function runShortcut(action: DirectorShortcut): boolean {
  switch (action) {
    case "delete":
      if (!selectedKeyframe.value && !selectedId.value) return false
      void removeSelection()
      return true
    case "undo":
      undo()
      return true
    case "redo":
      redo()
      return true
    case "toggle-play":
      playback.toggle()
      return true
  }
}

defineExpose({ runShortcut })

// —— gizmo：拖动是本地草稿，松手提交一次 ——

let unbindGizmo: (() => void) | null = null

function bindGizmo() {
  const controls = editor.transformControls
  if (!controls || unbindGizmo) return
  unbindGizmo = bindDirectorGizmoCommit(controls, {
    onStart(object) {
      playback.pause()
      dragging.add(object)
    },
    onCommit(id, change) {
      try {
        const { keyframed } = director.commitTransform(id, change, playback.playhead.value)
        if (keyframed.length > 0) {
          const labels = { position: "位置", rotation: "旋转", scale: "缩放" }
          toast.info(
            `${keyframed.map((p) => labels[p]).join("、")}有关键帧：这次拖动记成了 ${(playback.playhead.value / 1000).toFixed(2)}s 处的关键帧`
          )
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "变换失败")
      }
    },
    onEnd(object) {
      dragging.delete(object)
      // 提交成功时数据已经是新值；失败（对象被别人删了、超出范围）时这一下把草稿弹回去
      applyFrame()
    }
  })
}

// —— agent 写入的反馈：被远端改过的对象短暂高亮 ——

const HIGHLIGHT_MS = 1500
const highlights = new Map<string, { helper: THREE.BoxHelper; timer: ReturnType<typeof setTimeout> }>()

function objectIdsOfKeys(keys: ReadonlySet<string>): Set<string> {
  const scene = director.scene.value
  const ids = new Set<string>()
  for (const key of keys) {
    if (key.startsWith(`${DC_OBJECT_PREFIX}.`)) ids.add(key.slice(DC_OBJECT_PREFIX.length + 1))
    else if (key.startsWith(`${DC_TRACK_PREFIX}.`)) {
      const objectId = scene.tracks.get(key.slice(DC_TRACK_PREFIX.length + 1))?.objectId
      if (objectId) ids.add(objectId)
    } else if (key.startsWith(`${DC_KEYFRAME_PREFIX}.`)) {
      const trackId = scene.keyframes.get(key.slice(DC_KEYFRAME_PREFIX.length + 1))?.trackId
      const objectId = trackId ? scene.tracks.get(trackId)?.objectId : undefined
      if (objectId) ids.add(objectId)
    }
  }
  return ids
}

function highlight(id: string) {
  const object = projection.objectOf(id)
  if (!object) return
  const existing = highlights.get(id)
  if (existing) {
    clearTimeout(existing.timer)
    existing.timer = setTimeout(() => clearHighlight(id), HIGHLIGHT_MS)
    return
  }
  const helper = new THREE.BoxHelper(object, 0xffb020)
  editor.sceneHelpers.add(helper)
  highlights.set(id, { helper, timer: setTimeout(() => clearHighlight(id), HIGHLIGHT_MS) })
  editor.signals.sceneAnimated.dispatch()
}

function clearHighlight(id: string) {
  const entry = highlights.get(id)
  if (!entry) return
  clearTimeout(entry.timer)
  entry.helper.removeFromParent()
  entry.helper.dispose()
  highlights.delete(id)
  editor.signals.sceneAnimated.dispatch()
}

function refreshHighlights() {
  for (const [id, entry] of highlights) {
    if (!projection.objectOf(id)) clearHighlight(id)
    else entry.helper.update()
  }
}

director.onDataChange(({ keys, remote }) => {
  if (!remote || !props.agentEditing || !keys) return
  // 投影在 scene 的 watch 里才更新：等它对完账再找对象
  queueMicrotask(() => {
    for (const id of objectIdsOfKeys(keys)) highlight(id)
  })
})

// —— 生命周期 ——

onMounted(() => {
  editor.signals.objectSelected.add(onObjectSelected)
  editor.signals.sceneAnimated.add(refreshHighlights)
  // 渲染器在微任务里创建（见 useDirectorRenderer），投影排在它之后入场
  useDirectorRenderer(editor)
  queueMicrotask(() => {
    ready = true
    bindGizmo()
    syncScene()
  })
})

onBeforeUnmount(() => {
  unbindGizmo?.()
  editor.signals.objectSelected.remove(onObjectSelected)
  editor.signals.sceneAnimated.remove(refreshHighlights)
  for (const id of [...highlights.keys()]) clearHighlight(id)
  projection.clear()
  ready = false
})
</script>

<template>
  <!-- ThreeEditor 自己是 h-full 的纵向 flex：视口占满剩下的高度，时间轴贴底 -->
  <ThreeEditor :editor="editor">
      <div class="relative min-h-0 w-full flex-1 overflow-hidden">
        <EditorViewport class="absolute inset-0" />

        <!-- 左上：添加图形、撤销 / 重做、删除、设为当前机位 -->
        <div class="absolute left-4 top-4 z-10 flex items-center gap-1 rounded-lg border bg-card/95 p-1 shadow-sm backdrop-blur">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button size="xs" :loading="adding" data-testid="director-add">
                <Plus />
                添加
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                v-for="item in SHAPE_ITEMS"
                :key="item.kind"
                :data-kind="item.kind"
                @select="addObject(item.kind)"
              >
                <component :is="item.icon" />
                {{ DIRECTOR_KIND_LABELS[item.kind] }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="撤销（导演台）"
            title="撤销（Ctrl+Z）"
            :disabled="!director.history?.canUndo.value"
            data-testid="director-undo"
            @click="undo()"
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="重做（导演台）"
            title="重做（Ctrl+Shift+Z）"
            :disabled="!director.history?.canRedo.value"
            data-testid="director-redo"
            @click="redo()"
          >
            <Redo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            :aria-label="selectedKeyframe ? '删除选中的关键帧' : '删除选中的对象'"
            :title="selectedKeyframe ? '删除选中的关键帧（Delete）' : '删除选中的对象（Delete）'"
            :disabled="!selectedId && !selectedKeyframe"
            :loading="removing"
            data-testid="director-delete"
            @click="removeSelection()"
          >
            <Trash2 />
          </Button>
          <Button
            v-if="selectedObject?.kind === 'camera'"
            variant="ghost"
            size="xs"
            :disabled="director.scene.value.activeShot === selectedObject.id"
            :loading="settingShot"
            data-testid="director-active-shot"
            @click="setActiveShot()"
          >
            <Star />
            {{ director.scene.value.activeShot === selectedObject.id ? "当前机位" : "设为当前机位" }}
          </Button>
        </div>

        <!-- 右上：视角罗盘 + 变换模式（移动 / 旋转 / 缩放） -->
        <DirectorViewHelper class="absolute top-4 right-4 z-10 rounded-full bg-black/50" :size="72" />
        <DirectorTransformControls />
      </div>

    <DirectorTimeline
      :scene="director.scene.value"
      :playhead="playback.playhead.value"
      :playing="playback.playing.value"
      :loop="playback.loop.value"
      :selected-object-id="selectedId"
      :selected-keyframe-id="selectedKeyframe?.id ?? null"
      :can-keyframe="selectedId !== null"
      :keyframing="keyframing"
      @toggle="playback.toggle()"
      @toggle-loop="playback.loop.value = !playback.loop.value"
      @seek="(ms) => { playback.pause(); playback.seek(ms) }"
      @select-object="(id) => { selectedKeyframe = null; selectObject(id) }"
      @select-keyframe="(keyframe) => selectKeyframe(keyframe)"
      @keyframe="keyframeSelected()"
    />
  </ThreeEditor>
</template>
