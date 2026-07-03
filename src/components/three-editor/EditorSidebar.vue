<script setup lang="ts">
// @ts-nocheck
import { ref } from "vue"
import { Boxes, FolderCog, Settings } from "lucide-vue-next"

import SidebarScene from "./SidebarScene.vue"
import SidebarProperties from "./SidebarProperties.vue"
import SidebarSettings from "./SidebarSettings.vue"
import SidebarProject from "./SidebarProject.vue"
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
          <div v-show="activeTab === 'scene'" class="flex h-full flex-col">
            <SidebarScene class="h-1/2 shrink-0 border-b" />
            <SidebarProperties class="min-h-0 flex-1" />
          </div>
          <SidebarProject v-show="activeTab === 'project'" />
          <SidebarSettings v-show="activeTab === 'settings'" />
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
