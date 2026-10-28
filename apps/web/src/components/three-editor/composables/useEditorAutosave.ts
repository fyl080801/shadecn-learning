import { onBeforeUnmount, onMounted } from "vue"

export function useEditorAutosave(editor: any) {
  let saveStateTimeout: ReturnType<typeof setTimeout> | undefined

  onMounted(() => {
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
  })

  onBeforeUnmount(() => {
    clearTimeout(saveStateTimeout)
  })
}
