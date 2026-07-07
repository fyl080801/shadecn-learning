import { onBeforeUnmount, onMounted } from "vue"

import { applyUnlitCharacterMaterial, isCharacterObject } from "./characterPose"

// DirectorToolbar.vue 在创建素体预设时会调用 applyUnlitCharacterMaterial，
// 但自动保存恢复（IndexedDB -> THREE.ObjectLoader，见 useEditorAutosave.ts）
// 以及视口拖拽导入的 FBX（见 Loader.ts）都会跳过这一步——材质类型本身会被
// 序列化保存/还原，但换成 unlit 材质这个意图不会。角色一旦以旧的
// MeshPhongMaterial 状态被自动保存过，每次刷新都会还原出该材质，随后
// 下一次自动保存又会将其原样写回，形成不会自愈的循环。
//
// sceneGraphChanged 会在场景恢复（Editor.setScene）以及后续任何添加/删除
// 之后触发一次，因此在此做一次幂等扫描即可覆盖角色进入场景的所有入口。
export function useCharacterUnlitMaterial(editor: any) {
  function sweep() {
    for (const object of editor.scene.children) {
      if (isCharacterObject(object)) applyUnlitCharacterMaterial(object)
    }
  }

  onMounted(() => editor.signals.sceneGraphChanged.add(sweep))
  onBeforeUnmount(() => editor.signals.sceneGraphChanged.remove(sweep))
}
