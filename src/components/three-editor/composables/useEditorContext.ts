import { inject, provide, type InjectionKey } from "vue"

import { Editor } from "../Editor"

export const EditorKey: InjectionKey<any> = Symbol("editor")

export function createEditor() {
  return new (Editor as any)()
}

export function provideEditor(editor: any) {
  provide(EditorKey, editor)
  return editor
}

export function useEditor(): any {
  const editor = inject(EditorKey)
  if (!editor)
    throw new Error("useEditor() called outside of an editor provider")
  return editor
}
