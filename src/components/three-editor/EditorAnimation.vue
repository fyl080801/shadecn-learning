<script setup lang="ts">
// @ts-nocheck
import { onBeforeUnmount, onMounted, ref } from "vue"
import { Pause, Play, Square } from "lucide-vue-next"

import { AnimationPathHelper } from "three/addons/helpers/AnimationPathHelper.js"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useEditor } from "./composables/useEditorContext"

const editor = useEditor()
const signals = editor.signals
const strings = editor.strings
const mixer = editor.mixer

const t = (key: string) => strings.getKey(key)

const timeText = ref("0.00")
const durationText = ref("0.00")
const timeScale = ref(1)

const rootRef = ref<HTMLDivElement | null>(null)
const timelineAreaRef = ref<HTMLDivElement | null>(null)
const trackListRef = ref<HTMLDivElement | null>(null)
const playheadRef = ref<HTMLDivElement | null>(null)

let panelHeight = 36

const labelWidth = 150

// Track colors by type
const trackColors: Record<string, string> = {
  position: "#4CAF50",
  quaternion: "#2196F3",
  rotation: "#2196F3",
  scale: "#FF9800",
  morphTargetInfluences: "#9C27B0",
  default: "#607D8B"
}

function getTrackColor(trackName: string) {
  for (const type in trackColors) {
    if (trackName.endsWith("." + type)) {
      return trackColors[type]
    }
  }

  return trackColors.default
}

function getTrackType(trackName: string) {
  const parts = trackName.split(".")
  return parts[parts.length - 1]
}

let hoverHelper: any = null
let currentAction: any = null
let currentClip: any = null
let currentRoot: any = null
let isDragging = false
let rafId: number

function getAnimationClips() {
  const scene = editor.scene
  const clips: { clip: any; root: any }[] = []
  const seen = new Set()

  scene.traverse(function (object: any) {
    if (object.animations && object.animations.length > 0) {
      for (const clip of object.animations) {
        if (!seen.has(clip.uuid)) {
          seen.add(clip.uuid)
          clips.push({ clip, root: object })
        }
      }
    }
  })

  for (const clip of scene.animations) {
    if (!seen.has(clip.uuid)) {
      seen.add(clip.uuid)
      clips.push({ clip, root: scene })
    }
  }

  return clips
}

function getObjectName(trackName: string, root: any) {
  const dotIndex = trackName.lastIndexOf(".")
  if (dotIndex === -1) return trackName

  const uuid = trackName.substring(0, dotIndex)
  const object = root.getObjectByProperty("uuid", uuid)

  return object ? object.name || "Object" : uuid.substring(0, 8)
}

function updateTimeFromPosition(clientX: number) {
  const rect = timelineAreaRef.value!.getBoundingClientRect()
  const timelineStart = labelWidth
  const timelineWidth = rect.width - labelWidth
  const x = Math.max(0, Math.min(clientX - rect.left - timelineStart, timelineWidth))
  const percent = x / timelineWidth

  if (currentAction && currentClip) {
    const time = percent * currentClip.duration
    currentAction.play()
    currentAction.time = time
    currentAction.paused = true
    editor.mixer.update(0)
  }
}

function onTimelineMouseDown(event: MouseEvent) {
  const rect = timelineAreaRef.value!.getBoundingClientRect()
  if (event.clientX - rect.left > labelWidth) {
    event.preventDefault()

    isDragging = true
    updateTimeFromPosition(event.clientX)
  }
}

function onDocumentMouseMove(event: MouseEvent) {
  if (isDragging) {
    updateTimeFromPosition(event.clientX)
  }
}

function onDocumentMouseUp() {
  isDragging = false
}

function selectClip(clip: any, root: any) {
  if (currentAction) {
    currentAction.stop()
  }

  if (currentClip === clip) {
    currentAction = null
    currentClip = null
    currentRoot = null

    timeText.value = "0.00"
    durationText.value = "0.00"
  } else {
    currentClip = clip
    currentRoot = root
    currentAction = editor.mixer.clipAction(clip, root)

    durationText.value = clip.duration.toFixed(2)
  }
}

function showPath(clip: any, object: any) {
  hidePath()

  hoverHelper = new AnimationPathHelper(currentRoot, clip, object)
  editor.sceneHelpers.add(hoverHelper)
  signals.sceneGraphChanged.dispatch()
}

function hidePath() {
  if (hoverHelper) {
    editor.sceneHelpers.remove(hoverHelper)
    hoverHelper.dispose()
    hoverHelper = null
    signals.sceneGraphChanged.dispatch()
  }
}

function update() {
  const trackListContainer = trackListRef.value!
  trackListContainer.innerHTML = ""

  const clips = getAnimationClips()

  if (clips.length === 0) {
    return
  }

  for (const { clip, root } of clips) {
    const clipRow = document.createElement("div")
    clipRow.style.display = "flex"
    clipRow.style.alignItems = "center"
    clipRow.style.height = "24px"
    clipRow.style.borderBottom = "1px solid #ccc"
    clipRow.style.cursor = "pointer"
    clipRow.style.background = currentClip === clip ? "rgba(0, 136, 255, 0.1)" : ""

    const clipLabel = document.createElement("div")
    clipLabel.style.width = labelWidth + "px"
    clipLabel.style.padding = "0 10px"
    clipLabel.style.fontSize = "11px"
    clipLabel.style.fontWeight = "bold"
    clipLabel.style.overflow = "hidden"
    clipLabel.style.textOverflow = "ellipsis"
    clipLabel.style.whiteSpace = "nowrap"
    clipLabel.style.flexShrink = "0"
    clipLabel.style.boxSizing = "border-box"
    clipLabel.textContent = clip.name || "Animation"
    clipRow.appendChild(clipLabel)

    const clipTimeline = document.createElement("div")
    clipTimeline.style.flex = "1"
    clipTimeline.style.height = "100%"
    clipTimeline.style.background = "rgba(0,0,0,0.03)"
    clipRow.appendChild(clipTimeline)

    clipRow.addEventListener("click", function () {
      if (editor.selected !== root) {
        signals.objectSelected.remove(selectDefaultClip)
        editor.select(root)
        signals.objectSelected.add(selectDefaultClip)
      }

      selectClip(clip, root)
      update()
    })

    trackListContainer.appendChild(clipRow)

    if (currentClip === clip) {
      const duration = clip.duration

      for (const track of clip.tracks) {
        const times = track.times
        if (times.length === 0) continue

        const startTime = times[0]
        const endTime = times[times.length - 1]
        const startPercent = (startTime / duration) * 100
        const widthPercent = ((endTime - startTime) / duration) * 100

        const trackRow = document.createElement("div")
        trackRow.style.display = "flex"
        trackRow.style.alignItems = "center"
        trackRow.style.height = "20px"
        trackRow.style.borderBottom = "1px solid #eee"

        const trackLabel = document.createElement("div")
        trackLabel.style.width = labelWidth + "px"
        trackLabel.style.padding = "0 10px 0 20px"
        trackLabel.style.fontSize = "10px"
        trackLabel.style.overflow = "hidden"
        trackLabel.style.textOverflow = "ellipsis"
        trackLabel.style.whiteSpace = "nowrap"
        trackLabel.style.flexShrink = "0"
        trackLabel.style.boxSizing = "border-box"
        trackLabel.style.color = "#666"

        const objectName = getObjectName(track.name, root)
        const trackType = getTrackType(track.name)
        trackLabel.textContent = objectName + "." + trackType
        trackLabel.title = track.name
        trackRow.appendChild(trackLabel)

        const trackTimeline = document.createElement("div")
        trackTimeline.style.flex = "1"
        trackTimeline.style.height = "100%"
        trackTimeline.style.position = "relative"
        trackTimeline.style.background = "rgba(0,0,0,0.02)"

        const block = document.createElement("div")
        block.style.position = "absolute"
        block.style.left = startPercent + "%"
        block.style.width = Math.max(0.5, widthPercent) + "%"
        block.style.top = "3px"
        block.style.bottom = "3px"
        block.style.background = getTrackColor(track.name)
        block.style.borderRadius = "2px"
        block.style.opacity = "0.6"
        block.title =
          trackType + ": " + startTime.toFixed(2) + "s - " + endTime.toFixed(2) + "s"

        trackTimeline.appendChild(block)

        for (let i = 0; i < times.length; i++) {
          const keyframePercent = (times[i] / duration) * 100
          const keyframe = document.createElement("div")
          keyframe.style.position = "absolute"
          keyframe.style.left = keyframePercent + "%"
          keyframe.style.top = "50%"
          keyframe.style.width = "6px"
          keyframe.style.height = "6px"
          keyframe.style.marginLeft = "-3px"
          keyframe.style.marginTop = "-3px"
          keyframe.style.background = getTrackColor(track.name)
          keyframe.style.borderRadius = "1px"
          keyframe.style.transform = "rotate(45deg)"
          keyframe.title = times[i].toFixed(3) + "s"
          trackTimeline.appendChild(keyframe)
        }

        trackRow.appendChild(trackTimeline)

        if (track.name.endsWith(".position") && track.getValueSize() === 3) {
          const uuid = track.name.replace(".position", "")
          const object = root.getObjectByProperty("uuid", uuid)

          if (object) {
            trackRow.addEventListener("mouseenter", function () {
              showPath(clip, object)
            })

            trackRow.addEventListener("mouseleave", function () {
              hidePath()
            })
          }
        }

        trackListContainer.appendChild(trackRow)
      }
    }
  }
}

function clear() {
  hidePath()
  if (trackListRef.value) trackListRef.value.innerHTML = ""
  currentAction = null
  currentClip = null
  currentRoot = null
  timeText.value = "0.00"
  durationText.value = "0.00"
}

function updateTime() {
  if (currentAction && currentClip) {
    const time = currentAction.time % currentClip.duration
    timeText.value = time.toFixed(2)

    const rect = timelineAreaRef.value!.getBoundingClientRect()
    const timelineWidth = rect.width - labelWidth
    const playheadX = labelWidth + (time / currentClip.duration) * timelineWidth
    playheadRef.value!.style.left = playheadX + "px"
  }

  rafId = requestAnimationFrame(updateTime)
}

function selectDefaultClip(object: any) {
  if (object !== null && object.animations && object.animations.length > 0) {
    selectClip(object.animations[0], object)
    update()
  }
}

function onAnimationPanelResized(height: number) {
  panelHeight = height
  rootRef.value!.style.height = height + "px"
  signals.windowResize.dispatch()
}

function onTimeScaleChange() {
  mixer.timeScale = timeScale.value
}

function play() {
  if (currentAction) {
    if (currentAction.paused) {
      currentAction.paused = false
    } else if (!currentAction.isRunning()) {
      currentAction.reset()
      currentAction.play()
    }
  }
}

function pause() {
  if (currentAction) {
    currentAction.paused = true
  }
}

function stop() {
  if (currentAction) {
    currentAction.stop()
  }
}

onMounted(() => {
  rootRef.value!.style.height = panelHeight + "px"

  signals.animationPanelResized.add(onAnimationPanelResized)
  signals.objectSelected.add(selectDefaultClip)
  signals.editorCleared.add(clear)
  signals.objectAdded.add(update)
  signals.objectRemoved.add(update)

  document.addEventListener("mousemove", onDocumentMouseMove)
  document.addEventListener("mouseup", onDocumentMouseUp)

  update()
  updateTime()
})

onBeforeUnmount(() => {
  signals.animationPanelResized.remove(onAnimationPanelResized)
  signals.objectSelected.remove(selectDefaultClip)
  signals.editorCleared.remove(clear)
  signals.objectAdded.remove(update)
  signals.objectRemoved.remove(update)

  document.removeEventListener("mousemove", onDocumentMouseMove)
  document.removeEventListener("mouseup", onDocumentMouseUp)

  cancelAnimationFrame(rafId)
})
</script>

<template>
  <div ref="rootRef" class="flex shrink-0 flex-col overflow-hidden border-t bg-muted/40">
    <div class="flex shrink-0 items-center justify-center gap-1.5 border-b px-2.5 py-1.5">
      <Button variant="ghost" size="icon-sm" class="[&_svg]:size-3" @click="play">
        <Play fill="currentColor" />
      </Button>
      <Button variant="ghost" size="icon-sm" class="[&_svg]:size-3" @click="pause">
        <Pause fill="currentColor" />
      </Button>
      <Button variant="ghost" size="icon-sm" class="[&_svg]:size-3" @click="stop">
        <Square fill="currentColor" />
      </Button>

      <div
        class="ml-1 flex h-6 items-center justify-center gap-1 rounded bg-black/5 px-2 font-mono text-[11px]"
      >
        <span class="w-9 text-right">{{ timeText }}</span>
        <span>/</span>
        <span class="w-9">{{ durationText }}</span>
      </div>

      <span class="ml-2 text-xs text-muted-foreground">{{
        t("sidebar/animations/timescale")
      }}</span>
      <Input
        v-model.number="timeScale"
        type="number"
        step="0.1"
        min="-10"
        max="10"
        class="h-6 w-16 px-1.5 text-xs"
        @change="onTimeScaleChange"
      />
    </div>

    <div ref="timelineAreaRef" class="relative flex flex-1 flex-col overflow-hidden" @mousedown="onTimelineMouseDown">
      <div ref="trackListRef" class="flex-1 overflow-x-hidden overflow-y-auto" />
      <div
        ref="playheadRef"
        class="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-red-500"
        style="left: 150px"
      />
    </div>
  </div>
</template>
