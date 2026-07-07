<script setup lang="ts">
import { reactive, watch } from "vue"

import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Button } from "@/components/ui/button"
import { useEditor } from "@/components/three-editor/composables/useEditorContext"
import {
  BONE_GROUPS,
  POSE_PRESET_LIST,
  applyPoseValues,
  createEmptyPoseValues,
  ensureSkeletonLines,
  resolvePosePreset,
  type PoseValues
} from "./characterPose"

const props = defineProps<{ character: any }>()

const editor = useEditor()

// 持久化在角色根节点的 userData 上（与 DirectorObjectPropertiesPanel 中的
// scaleBase/uniformScale 约定相同），使重新选中角色时恢复滑块值而非跳回 T-pose。
function ensurePoseState(character: any): PoseValues {
  if (!character.userData.poseValues) {
    character.userData.poseValues = createEmptyPoseValues()
  }
  return character.userData.poseValues
}

const poseValues = reactive<PoseValues>(createEmptyPoseValues())

function syncFromCharacter(character: any) {
  const stored = ensurePoseState(character)
  Object.assign(poseValues, stored)
}

watch(
  () => props.character,
  (character) => {
    if (character) syncFromCharacter(character)
  },
  { immediate: true }
)

function commit() {
  const character = props.character
  if (!character) return

  Object.assign(
    character.userData.poseValues ?? ensurePoseState(character),
    poseValues
  )
  applyPoseValues(character, poseValues)

  // 必须先于 dispatch 重建骨架线，而非依赖 DirectorObjectPropertiesPanel 的
  // objectChanged 监听器去做——EditorViewport 在模板中先于该侧栏面板挂载，
  // 因此其 objectChanged 监听器（调用 render()）会先于侧栏面板的监听器
  // （重建骨架线几何）执行。若在此不提前重建，render() 会先画出上一次的
  // 骨架线，新几何要等到下一次 dispatch 才会被画出——骨架相对模型慢一拍。
  ensureSkeletonLines(editor, character)

  editor.signals.objectChanged.dispatch(character)
}

function setControl(key: string, value: number) {
  poseValues[key] = value
  commit()
}

function applyPreset(key: string) {
  Object.assign(poseValues, resolvePosePreset(key))
  commit()
}

const sections: { title: string; groupKeys: string[] }[] = [
  { title: "身体", groupKeys: ["body"] },
  { title: "躯干", groupKeys: ["torso"] },
  { title: "头部", groupKeys: ["head"] },
  { title: "手臂 - 肩", groupKeys: ["leftShoulder", "rightShoulder"] },
  { title: "肘部", groupKeys: ["leftElbow", "rightElbow"] },
  { title: "腿部 - 髋", groupKeys: ["leftHip", "rightHip"] },
  { title: "膝部", groupKeys: ["leftKnee", "rightKnee"] }
]

function groupByKey(key: string) {
  return BONE_GROUPS.find((g) => g.groupKey === key)!
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="space-y-2">
      <Label class="text-xs">姿势预设</Label>
      <div class="grid grid-cols-4 gap-1.5">
        <Button
          v-for="preset in POSE_PRESET_LIST"
          :key="preset.key"
          variant="outline"
          size="sm"
          class="h-7 px-1 text-[11px]"
          @click="applyPreset(preset.key)"
        >
          {{ preset.label }}
        </Button>
      </div>
    </div>

    <Separator />

    <div class="space-y-1">
      <Label class="text-xs">姿势调节</Label>

      <template v-for="section in sections" :key="section.title">
        <div class="mt-3 space-y-2">
          <div class="text-[11px] font-medium text-muted-foreground">
            {{ section.title }}
          </div>

          <template v-if="section.groupKeys.length === 1">
            <div
              v-for="control in groupByKey(section.groupKeys[0]!).controls"
              :key="control.key"
              class="space-y-1"
            >
              <div
                class="flex items-center justify-between text-[10px] text-muted-foreground"
              >
                <span>{{ control.label }}</span>
                <span>{{ poseValues[control.key] }}</span>
              </div>
              <Slider
                :model-value="[poseValues[control.key] ?? 0]"
                :min="control.min"
                :max="control.max"
                :step="1"
                @update:model-value="
                  (v) => setControl(control.key, v?.[0] ?? 0)
                "
              />
            </div>
          </template>

          <template v-else>
            <div
              v-for="groupKey in section.groupKeys"
              :key="groupKey"
              class="space-y-2 pl-2"
            >
              <div class="text-[10px] text-muted-foreground">
                {{ groupByKey(groupKey).label }}
              </div>
              <div
                v-for="control in groupByKey(groupKey).controls"
                :key="control.key"
                class="space-y-1"
              >
                <div
                  class="flex items-center justify-between text-[10px] text-muted-foreground"
                >
                  <span>{{ control.label }}</span>
                  <span>{{ poseValues[control.key] }}</span>
                </div>
                <Slider
                  :model-value="[poseValues[control.key] ?? 0]"
                  :min="control.min"
                  :max="control.max"
                  :step="1"
                  @update:model-value="
                    (v) => setControl(control.key, v?.[0] ?? 0)
                  "
                />
              </div>
            </div>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>
