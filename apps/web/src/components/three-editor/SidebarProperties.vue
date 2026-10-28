<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"

import { useEditor } from "./composables/useEditorContext"
import SidebarObject from "./SidebarObject.vue"
import SidebarGeometry from "./SidebarGeometry.vue"
import SidebarMaterial from "./SidebarMaterial.vue"
import SidebarScript from "./SidebarScript.vue"
import SidebarSkeleton from "./SidebarSkeleton.vue"

import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

const editor = useEditor()
const strings = editor.strings
const t = (key: string) => strings.getKey(key)

const selected = ref<any>(editor.selected)
const activeTab = ref("objectTab")

const showGeometryTab = computed(() => !!selected.value?.geometry)
const showMaterialTab = computed(() => !!selected.value?.material)
const showScriptTab = computed(
  () => selected.value !== null && selected.value !== editor.camera
)
const showSkeletonTab = computed(
  () => !!selected.value?.isSkinnedMesh || !!selected.value?.isBone
)

function onObjectSelected(object: any) {
  selected.value = object

  if (object === null) return

  if (!showGeometryTab.value && activeTab.value === "geometryTab") {
    activeTab.value = "objectTab"
  }
  if (!showMaterialTab.value && activeTab.value === "materialTab") {
    activeTab.value = "objectTab"
  }
  if (!showScriptTab.value && activeTab.value === "scriptTab") {
    activeTab.value = "objectTab"
  }
  if (!showSkeletonTab.value && activeTab.value === "skeletonTab") {
    activeTab.value = "objectTab"
  }
}

onMounted(() => {
  editor.signals.objectSelected.add(onObjectSelected)
})

onBeforeUnmount(() => {
  editor.signals.objectSelected.remove(onObjectSelected)
})
</script>

<template>
  <div v-show="selected" class="te-sidebar-properties flex h-full flex-col">
    <Tabs v-model="activeTab" class="flex h-full min-h-0 flex-col gap-0">
      <TabsList class="w-full shrink-0 rounded-none">
        <TabsTrigger value="objectTab" class="flex-1 text-xs">
          {{ t("sidebar/properties/object") }}
        </TabsTrigger>
        <TabsTrigger
          v-if="showGeometryTab"
          value="geometryTab"
          class="flex-1 text-xs"
        >
          {{ t("sidebar/properties/geometry") }}
        </TabsTrigger>
        <TabsTrigger
          v-if="showMaterialTab"
          value="materialTab"
          class="flex-1 text-xs"
        >
          {{ t("sidebar/properties/material") }}
        </TabsTrigger>
        <TabsTrigger
          v-if="showScriptTab"
          value="scriptTab"
          class="flex-1 text-xs"
        >
          {{ t("sidebar/properties/script") }}
        </TabsTrigger>
        <TabsTrigger
          v-if="showSkeletonTab"
          value="skeletonTab"
          class="flex-1 text-xs"
        >
          {{ t("sidebar/properties/skeleton") }}
        </TabsTrigger>
      </TabsList>
      <ScrollArea class="min-h-0 flex-1">
        <TabsContent value="objectTab">
          <SidebarObject />
        </TabsContent>
        <TabsContent value="geometryTab">
          <SidebarGeometry />
        </TabsContent>
        <TabsContent value="materialTab">
          <SidebarMaterial />
        </TabsContent>
        <TabsContent value="scriptTab">
          <SidebarScript />
        </TabsContent>
        <TabsContent value="skeletonTab">
          <SidebarSkeleton />
        </TabsContent>
      </ScrollArea>
    </Tabs>
  </div>
</template>
