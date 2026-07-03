<script setup lang="ts">
// @ts-nocheck
import { onBeforeUnmount, onMounted, ref } from "vue"
import { Boxes, FolderCog, Settings } from "lucide-vue-next"

import { SidebarScene } from "./Sidebar.Scene"
import { SidebarProperties } from "./Sidebar.Properties"
import { SidebarProject } from "./Sidebar.Project"
import { SidebarSettings } from "./Sidebar.Settings"
import { useEditor } from "./composables/useEditorContext"

import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider
} from "@/components/ui/sidebar"

const editor = useEditor()
const strings = editor.strings
const t = (key: string) => strings.getKey(key)

const tabs = [
  { id: "scene", label: "sidebar/scene", icon: Boxes },
  { id: "project", label: "sidebar/project", icon: FolderCog },
  { id: "settings", label: "sidebar/settings", icon: Settings }
] as const

const activeTab = ref<(typeof tabs)[number]["id"]>("scene")

const sceneRef = ref<HTMLDivElement | null>(null)
const projectRef = ref<HTMLDivElement | null>(null)
const settingsRef = ref<HTMLDivElement | null>(null)

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  const scene = new (SidebarScene as any)(editor)
  const sidebarProperties = new (SidebarProperties as any)(editor)
  sceneRef.value?.appendChild(scene.dom)
  sceneRef.value?.appendChild(sidebarProperties.dom)

  const project = new (SidebarProject as any)(editor)
  projectRef.value?.appendChild(project.dom)

  const settings = new (SidebarSettings as any)(editor)
  settingsRef.value?.appendChild(settings.dom)

  // The properties tabs need to know the sidebar's width to lay themselves out.
  resizeObserver = new ResizeObserver(() => {
    sidebarProperties.tabsDiv.setWidth(getComputedStyle(sceneRef.value!).width)
  })
  if (sceneRef.value) resizeObserver.observe(sceneRef.value)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
})
</script>

<template>
  <div id="sidebar">
    <SidebarProvider class="te-sidebar h-full min-h-full w-full">
      <Sidebar collapsible="none" class="h-full w-full">
        <SidebarHeader class="border-b p-0">
          <SidebarMenu class="flex-row">
            <SidebarMenuItem v-for="tab in tabs" :key="tab.id" class="flex-1">
              <SidebarMenuButton
                :is-active="activeTab === tab.id"
                class="justify-center rounded-none"
                @click="activeTab = tab.id"
              >
                <component :is="tab.icon" />
                <span>{{ t(tab.label) }}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <div v-show="activeTab === 'scene'" ref="sceneRef" />
          <div v-show="activeTab === 'project'" ref="projectRef" />
          <div v-show="activeTab === 'settings'" ref="settingsRef" />
        </SidebarContent>
      </Sidebar>
    </SidebarProvider>
  </div>
</template>

<style scoped>
#sidebar {
  overflow: hidden;
}
</style>
