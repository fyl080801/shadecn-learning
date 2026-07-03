import { mountDialog } from "./libs/mountDialog"
import TextureParametersDialogView from "./TextureParametersDialog.vue"

class TextureParametersDialog {
  editor: any
  texture: any

  constructor(editor: any, texture: any) {
    this.editor = editor
    this.texture = texture
  }

  show(): Promise<any> {
    return new Promise((resolve, reject) => {
      const { props, unmount } = mountDialog(TextureParametersDialogView, {
        open: true,
        editor: this.editor,
        texture: this.texture,
        "onUpdate:open": (value: boolean) => {
          props.open = value
        },
        onConfirm: (parameters: any) => {
          unmount()
          resolve(parameters)
        },
        onCancel: () => {
          unmount()
          reject(new Error("Texture parameters edit cancelled"))
        }
      })
    })
  }
}

export { TextureParametersDialog }
