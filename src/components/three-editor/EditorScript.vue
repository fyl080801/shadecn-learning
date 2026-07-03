<script setup lang="ts">
// @ts-nocheck
import { onBeforeUnmount, onMounted, ref } from "vue"
import { X } from "lucide-vue-next"

import { EditorView, basicSetup } from "codemirror"
import { EditorState } from "@codemirror/state"
import { javascript } from "@codemirror/lang-javascript"
import { json as jsonLang } from "@codemirror/lang-json"
import { oneDark } from "@codemirror/theme-one-dark"

import { Button } from "@/components/ui/button"

import { SetScriptValueCommand } from "./commands/SetScriptValueCommand"
import { SetMaterialValueCommand } from "./commands/SetMaterialValueCommand"
import { useEditor } from "./composables/useEditorContext"

defineOptions({ inheritAttrs: false })

const editor = useEditor()
const signals = editor.signals
const strings = editor.strings

const visible = ref(false)
const title = ref("")
const errorMessage = ref("")

const editorContainerRef = ref<HTMLDivElement | null>(null)

const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px" },
  ".cm-scroller": { overflow: "auto" }
})

let renderer: any
let view: EditorView

let delay: ReturnType<typeof setTimeout> | undefined
let currentMode: string | undefined
let currentScript: any
let currentObject: any

function languageExtension(mode?: string) {
  if (mode === "javascript") return [javascript()]
  if (mode === "json") return [jsonLang()]
  return []
}

function createState(source: string, mode?: string) {
  return EditorState.create({
    doc: source,
    extensions: [
      basicSetup,
      oneDark,
      editorTheme,
      languageExtension(mode),
      EditorView.updateListener.of(function (update) {
        if (update.docChanged && view.hasFocus) handleChange()
      })
    ]
  })
}

function handleChange() {
  clearTimeout(delay)
  delay = window.setTimeout(function () {
    const value = view.state.doc.toString()

    if (!validate(value)) return

    if (typeof currentScript === "object") {
      if (value !== currentScript.source) {
        editor.execute(
          new SetScriptValueCommand(
            editor,
            currentObject,
            currentScript,
            "source",
            value
          )
        )
      }

      return
    }

    if (currentScript !== "programInfo") return

    const json = JSON.parse(value)

    if (
      JSON.stringify(currentObject.material.defines) !==
      JSON.stringify(json.defines)
    ) {
      const cmd = new SetMaterialValueCommand(
        editor,
        currentObject,
        "defines",
        json.defines
      )
      cmd.updatable = false
      editor.execute(cmd)
    }

    if (
      JSON.stringify(currentObject.material.uniforms) !==
      JSON.stringify(json.uniforms)
    ) {
      const cmd = new SetMaterialValueCommand(
        editor,
        currentObject,
        "uniforms",
        json.uniforms
      )
      cmd.updatable = false
      editor.execute(cmd)
    }

    if (
      JSON.stringify(currentObject.material.attributes) !==
      JSON.stringify(json.attributes)
    ) {
      const cmd = new SetMaterialValueCommand(
        editor,
        currentObject,
        "attributes",
        json.attributes
      )
      cmd.updatable = false
      editor.execute(cmd)
    }
  }, 300)
}

function showErrors(messages: string[]) {
  errorMessage.value = messages.join("\n")
}

function validate(string: string) {
  const messages: string[] = []
  let valid = true

  switch (currentMode) {
    case "javascript":
      try {
        new Function(string) // eslint-disable-line no-new-func
      } catch (error: any) {
        messages.push(error.message)
        valid = false
      }

      break

    case "json":
      try {
        JSON.parse(string)
      } catch (error: any) {
        messages.push(error.message)
        valid = false
      }

      break

    case "glsl": {
      currentObject.material[currentScript] = string
      currentObject.material.needsUpdate = true
      signals.materialChanged.dispatch(currentObject, 0) // TODO: Add multi-material support

      const programs = renderer ? renderer.info.programs : undefined
      const parseMessage = /^(?:ERROR|WARNING): \d+:(\d+): (.*)/g

      if (programs) {
        for (let i = 0, n = programs.length; i !== n; ++i) {
          const diagnostics = programs[i].diagnostics

          if (
            diagnostics === undefined ||
            diagnostics.material !== currentObject.material
          )
            continue

          if (!diagnostics.runnable) valid = false

          const shaderInfo = diagnostics[currentScript]
          let parseResult

          while ((parseResult = parseMessage.exec(shaderInfo.log)) !== null) {
            messages.push(`Line ${parseResult[1]}: ${parseResult[2]}`)
          }

          break
        }
      }

      break
    }
  }

  showErrors(messages)

  return valid
}

function setTitle(object: any, script: any) {
  if (typeof script === "object") {
    title.value = object.name + " / " + script.name
  } else {
    switch (script) {
      case "vertexShader":
        title.value =
          object.material.name +
          " / " +
          strings.getKey("script/title/vertexShader")
        break

      case "fragmentShader":
        title.value =
          object.material.name +
          " / " +
          strings.getKey("script/title/fragmentShader")
        break

      case "programInfo":
        title.value =
          object.material.name +
          " / " +
          strings.getKey("script/title/programInfo")
        break

      default:
        throw new Error("setTitle: Unknown script")
    }
  }
}

function close() {
  visible.value = false
}

function onRendererCreated(newRenderer: any) {
  renderer = newRenderer
}

function onEditorCleared() {
  visible.value = false
}

function onEditScript(object: any, script: any) {
  let mode: string | undefined
  let source: string

  if (typeof script === "object") {
    mode = "javascript"
    source = script.source
  } else {
    switch (script) {
      case "vertexShader":
        mode = "glsl"
        source = object.material.vertexShader || ""
        break

      case "fragmentShader":
        mode = "glsl"
        source = object.material.fragmentShader || ""
        break

      case "programInfo": {
        mode = "json"
        const json = {
          defines: object.material.defines,
          uniforms: object.material.uniforms,
          attributes: object.material.attributes
        }
        source = JSON.stringify(json, null, "\t")
        break
      }

      default:
        throw new Error("editScript: Unknown script")
    }
  }

  setTitle(object, script)

  currentMode = mode
  currentScript = script
  currentObject = object

  visible.value = true
  showErrors([])
  view.setState(createState(source, mode))
}

function onScriptRemoved(script: any) {
  if (currentScript === script) {
    visible.value = false
  }
}

function onObjectChanged(object: any) {
  if (object !== currentObject) return
  if (["programInfo", "vertexShader", "fragmentShader"].includes(currentScript))
    return
  setTitle(currentObject, currentScript)
}

function onScriptChanged(script: any) {
  if (script === currentScript) {
    setTitle(currentObject, currentScript)
  }
}

function onMaterialChanged(object: any /*, slot */) {
  if (object !== currentObject) return
  setTitle(currentObject, currentScript)
}

onMounted(() => {
  view = new EditorView({
    parent: editorContainerRef.value!,
    state: createState("", undefined)
  })

  // prevent backspace from deleting objects
  view.dom.addEventListener("keydown", function (event) {
    event.stopPropagation()
  })

  signals.rendererCreated.add(onRendererCreated)
  signals.editorCleared.add(onEditorCleared)
  signals.editScript.add(onEditScript)
  signals.scriptRemoved.add(onScriptRemoved)
  signals.objectChanged.add(onObjectChanged)
  signals.scriptChanged.add(onScriptChanged)
  signals.materialChanged.add(onMaterialChanged)
})

onBeforeUnmount(() => {
  signals.rendererCreated.remove(onRendererCreated)
  signals.editorCleared.remove(onEditorCleared)
  signals.editScript.remove(onEditScript)
  signals.scriptRemoved.remove(onScriptRemoved)
  signals.objectChanged.remove(onObjectChanged)
  signals.scriptChanged.remove(onScriptChanged)
  signals.materialChanged.remove(onMaterialChanged)

  view?.destroy()
})
</script>

<template>
  <div
    v-show="visible"
    v-bind="$attrs"
    class="te-script flex flex-col bg-[#272822] opacity-90"
  >
    <div class="relative flex shrink-0 items-center px-2.5 py-2.5">
      <span class="text-sm text-white">{{ title }}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        class="absolute top-0 right-0 text-white hover:bg-white/10 hover:text-white"
        @click="close"
      >
        <X />
      </Button>
    </div>
    <div class="relative min-h-0 flex-1">
      <div ref="editorContainerRef" class="absolute inset-0" />
      <div
        v-show="errorMessage"
        class="absolute inset-x-0 bottom-0 max-h-[35%] overflow-auto bg-red-500/15 p-2 font-mono text-xs whitespace-pre-wrap text-red-400"
      >
        {{ errorMessage }}
      </div>
    </div>
  </div>
</template>
