<script setup lang="ts">
import { ref, shallowRef, onMounted, onBeforeUnmount } from "vue"
import * as THREE from "three"

import { Editor } from "@/components/three-editor/Editor"
import { Viewport } from "@/components/three-editor/Viewport"
import { Toolbar } from "@/components/three-editor/Toolbar"
import { Script } from "@/components/three-editor/Script"
import { Player } from "@/components/three-editor/Player"
import { Sidebar } from "@/components/three-editor/Sidebar"
import { Resizer } from "@/components/three-editor/Resizer"
import { AnimationResizer } from "@/components/three-editor/AnimationResizer"
import { Animation } from "@/components/three-editor/Animation"
import EditorMenubar from "@/components/three-editor/EditorMenubar.vue"

const CSS_HREF = "/three-editor/css/main.css"

const containerRef = ref<HTMLDivElement | null>(null)
const editorRef = shallowRef<any>(null)

let cssLink: HTMLLinkElement | null = null
let renderer: THREE.WebGLRenderer | undefined
let saveStateTimeout: ReturnType<typeof setTimeout> | undefined
let resizeObserver: ResizeObserver | null = null

let onDragover: ((e: DragEvent) => void) | null = null
let onDrop: ((e: DragEvent) => void) | null = null
let onResize: (() => void) | null = null

onMounted(async () => {
  const container = containerRef.value!

  cssLink = document.createElement("link")
  cssLink.rel = "stylesheet"
  cssLink.href = CSS_HREF
  document.head.appendChild(cssLink)

  window.URL = window.URL || (window as any).webkitURL

  const editor = new (Editor as any)()
  editorRef.value = editor

  editor.signals.rendererCreated.add((newRenderer: THREE.WebGLRenderer) => {
    renderer = newRenderer
  })

  const viewport = new (Viewport as any)(editor)
  container.appendChild(viewport.dom)

  const toolbar = new (Toolbar as any)(editor)
  container.appendChild(toolbar.dom)

  const script = new (Script as any)(editor)
  container.appendChild(script.dom)

  const player = new (Player as any)(editor)
  container.appendChild(player.dom)

  const sidebar = new (Sidebar as any)(editor)
  container.appendChild(sidebar.dom)

  const resizer = new (Resizer as any)(editor)
  container.appendChild(resizer.dom)

  const animation = new (Animation as any)(editor)
  container.appendChild(animation.dom)

  const animationResizer = new (AnimationResizer as any)(editor)
  container.appendChild(animationResizer.dom)

  editor.signals.animationPanelChanged.add((height: number | false) => {
    const visible = height !== false
    viewport.dom.classList.toggle("with-animation", visible)
    toolbar.dom.classList.toggle("with-animation", visible)
    if (visible) {
      viewport.dom.style.bottom = height + "px"
      toolbar.dom.style.bottom = height + 20 + "px"
    } else {
      viewport.dom.style.bottom = ""
      toolbar.dom.style.bottom = ""
    }
    editor.signals.windowResize.dispatch()
  })

  editor.storage.init(() => {
    editor.storage.get(async (state: unknown) => {
      if (state !== undefined) {
        await editor.fromJSON(state)
      } else {
        editor.signals.sceneEnvironmentChanged.dispatch("Default")
      }
      const selected = editor.config.getKey("selected")
      if (selected !== undefined) editor.selectByUuid(selected)
    })

    function saveState() {
      if (editor.config.getKey("autosave") === false) return
      clearTimeout(saveStateTimeout)
      saveStateTimeout = setTimeout(() => {
        editor.signals.savingStarted.dispatch()
        saveStateTimeout = setTimeout(() => {
          editor.storage.set(editor.toJSON())
          editor.signals.savingFinished.dispatch()
        }, 100)
      }, 1000)
    }

    const s = editor.signals
    s.cameraResetted.add(saveState)
    s.geometryChanged.add(saveState)
    s.objectAdded.add(saveState)
    s.objectChanged.add(saveState)
    s.objectRemoved.add(saveState)
    s.materialChanged.add(saveState)
    s.sceneBackgroundChanged.add(saveState)
    s.sceneEnvironmentChanged.add(saveState)
    s.sceneFogChanged.add(saveState)
    s.sceneGraphChanged.add(saveState)
    s.scriptChanged.add(saveState)
    s.historyChanged.add(saveState)
  })

  onDragover = (e: DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"
  }
  onDrop = (e: DragEvent) => {
    e.preventDefault()
    if (!e.dataTransfer) return
    if (e.dataTransfer.types[0] === "text/plain") return
    if (e.dataTransfer.items) editor.loader.loadItemList(e.dataTransfer.items)
    else editor.loader.loadFiles(e.dataTransfer.files)
  }
  onResize = () => editor.signals.windowResize.dispatch()

  container.addEventListener("dragover", onDragover)
  container.addEventListener("drop", onDrop)
  window.addEventListener("resize", onResize)

  resizeObserver = new ResizeObserver(() => {
    editor.signals.windowResize.dispatch()
  })
  resizeObserver.observe(container)

  editor.signals.windowResize.dispatch()
})

onBeforeUnmount(() => {
  if (onDragover)
    containerRef.value?.removeEventListener("dragover", onDragover)
  if (onDrop) containerRef.value?.removeEventListener("drop", onDrop)
  if (onResize) window.removeEventListener("resize", onResize)
  resizeObserver?.disconnect()
  clearTimeout(saveStateTimeout)

  if (renderer) {
    renderer.setAnimationLoop(null)
    renderer.dispose()
  }

  cssLink?.remove()
})
</script>

<template>
  <div ref="containerRef" class="relative w-full h-full overflow-hidden">
    <EditorMenubar v-if="editorRef" :editor="editorRef" />
  </div>
</template>
