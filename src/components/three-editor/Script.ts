// @ts-nocheck
import { EditorView, basicSetup } from "codemirror"
import { EditorState } from "@codemirror/state"
import { javascript } from "@codemirror/lang-javascript"
import { json as jsonLang } from "@codemirror/lang-json"
import { oneDark } from "@codemirror/theme-one-dark"

import { UIElement, UIPanel, UIText } from "./libs/ui"

import { SetScriptValueCommand } from "./commands/SetScriptValueCommand"
import { SetMaterialValueCommand } from "./commands/SetMaterialValueCommand"

const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px" },
  ".cm-scroller": { overflow: "auto" }
})

function Script(editor) {
  const signals = editor.signals
  const strings = editor.strings

  const container = new UIPanel()
  container.setId("script")
  container.setPosition("absolute")
  container.setBackgroundColor("#272822")
  container.setDisplay("none")

  const header = new UIPanel()
  header.setPadding("10px")
  container.add(header)

  const title = new UIText().setColor("#fff")
  header.add(title)

  const buttonSVG = (function () {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("width", 32)
    svg.setAttribute("height", 32)
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("d", "M 12,12 L 22,22 M 22,12 12,22")
    path.setAttribute("stroke", "#fff")
    svg.appendChild(path)
    return svg
  })()

  const close = new UIElement(buttonSVG)
  close.setPosition("absolute")
  close.setTop("3px")
  close.setRight("1px")
  close.setCursor("pointer")
  close.onClick(function () {
    container.setDisplay("none")
  })
  header.add(close)

  let renderer

  signals.rendererCreated.add(function (newRenderer) {
    renderer = newRenderer
  })

  let delay
  let currentMode
  let currentScript
  let currentObject

  // editor

  const editorContainer = document.createElement("div")
  editorContainer.style.position = "absolute"
  editorContainer.style.top = "37px"
  editorContainer.style.left = "0"
  editorContainer.style.right = "0"
  editorContainer.style.bottom = "0"
  container.dom.appendChild(editorContainer)

  const errorPanel = document.createElement("div")
  errorPanel.style.position = "absolute"
  errorPanel.style.left = "0"
  errorPanel.style.right = "0"
  errorPanel.style.bottom = "0"
  errorPanel.style.maxHeight = "35%"
  errorPanel.style.overflow = "auto"
  errorPanel.style.background = "rgba(255,0,0,0.15)"
  errorPanel.style.color = "#f77"
  errorPanel.style.fontFamily = "monospace"
  errorPanel.style.fontSize = "12px"
  errorPanel.style.padding = "4px 8px"
  errorPanel.style.whiteSpace = "pre-wrap"
  errorPanel.style.display = "none"
  editorContainer.appendChild(errorPanel)

  function languageExtension(mode) {
    if (mode === "javascript") return [javascript()]
    if (mode === "json") return [jsonLang()]
    return []
  }

  function createState(source, mode) {
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

  const view = new EditorView({
    parent: editorContainer,
    state: createState("", undefined)
  })

  // prevent backspace from deleting objects

  view.dom.addEventListener("keydown", function (event) {
    event.stopPropagation()
  })

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

  // validate (simplified: no esprima/jsonlint/tern, just basic syntax checks)

  function showErrors(messages) {
    if (messages.length === 0) {
      errorPanel.style.display = "none"
      errorPanel.textContent = ""
      return
    }

    errorPanel.style.display = "block"
    errorPanel.textContent = messages.join("\n")
  }

  const validate = function (string) {
    const messages = []
    let valid = true

    switch (currentMode) {
      case "javascript":
        try {
          new Function(string) // eslint-disable-line no-new-func
        } catch (error) {
          messages.push(error.message)
          valid = false
        }

        break

      case "json":
        try {
          JSON.parse(string)
        } catch (error) {
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

  //

  signals.editorCleared.add(function () {
    container.setDisplay("none")
  })

  function setTitle(object, script) {
    if (typeof script === "object") {
      title.setValue(object.name + " / " + script.name)
    } else {
      switch (script) {
        case "vertexShader":
          title.setValue(
            object.material.name +
              " / " +
              strings.getKey("script/title/vertexShader")
          )
          break

        case "fragmentShader":
          title.setValue(
            object.material.name +
              " / " +
              strings.getKey("script/title/fragmentShader")
          )
          break

        case "programInfo":
          title.setValue(
            object.material.name +
              " / " +
              strings.getKey("script/title/programInfo")
          )
          break

        default:
          throw new Error("setTitle: Unknown script")
      }
    }
  }

  signals.editScript.add(function (object, script) {
    let mode, source

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

    container.setDisplay("")
    showErrors([])
    view.setState(createState(source, mode))
  })

  signals.scriptRemoved.add(function (script) {
    if (currentScript === script) {
      container.setDisplay("none")
    }
  })

  signals.objectChanged.add(function (object) {
    if (object !== currentObject) return

    if (
      ["programInfo", "vertexShader", "fragmentShader"].includes(currentScript)
    )
      return

    setTitle(currentObject, currentScript)
  })

  signals.scriptChanged.add(function (script) {
    if (script === currentScript) {
      setTitle(currentObject, currentScript)
    }
  })

  signals.materialChanged.add(function (object /*, slot */) {
    if (object !== currentObject) return

    // TODO: Adds multi-material support

    setTitle(currentObject, currentScript)
  })

  return container
}

export { Script }
