import { mountDialog } from "./libs/mountDialog"
import GLTFImportDialogView from "./GLTFImportDialog.vue"

class GLTFImportDialog {
  strings: any

  constructor(strings: any) {
    this.strings = strings
  }

  show(): Promise<{ asScene: boolean }> {
    return new Promise((resolve, reject) => {
      const { props, unmount } = mountDialog(GLTFImportDialogView, {
        open: true,
        strings: this.strings,
        "onUpdate:open": (value: boolean) => {
          props.open = value
        },
        onConfirm: (asScene: boolean) => {
          unmount()
          resolve({ asScene })
        },
        onCancel: () => {
          unmount()
          reject(new Error("Import cancelled"))
        }
      })
    })
  }
}

export { GLTFImportDialog }
