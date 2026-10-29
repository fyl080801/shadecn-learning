import { onBeforeUnmount, onMounted } from "vue"

import { normalizeShapeMaterial } from "./directorShapeMaterial"

// 存量场景里的图形材质是按当时的出厂值（roughness = 1，全漫反射）存下来的，恢复时
// ObjectLoader 会把那份参数原样还原，随后下一次保存又把它写回去——不做一次归一的话，
// 那些图形永远停在「没有光泽的一块色」上，且这个循环不会自愈。同 useCharacterUnlitMaterial
// 面对的问题（材质**意图**不进序列化，只有参数进）。
//
// sceneGraphChanged 在场景恢复（Editor.setScene）与此后任何增删之后都会触发一次，故在这里
// 做一次幂等扫描即可覆盖图形进入场景的所有入口。扫描只看顶层对象的内容节点（一次性、不做
// 整树 traverse），代价与对象数同阶。
export function useDirectorShapeMaterial(editor: any) {
  function sweep() {
    let changed = false
    for (const object of editor.scene.children) {
      if (normalizeShapeMaterial(object)) changed = true
    }
    // 只在真的改了参数时请求重绘：本函数自身挂在 sceneGraphChanged 上，无条件回派发
    // 就是一个自激循环。
    if (changed) editor.signals.materialChanged.dispatch()
  }

  onMounted(() => editor.signals.sceneGraphChanged.add(sweep))
  onBeforeUnmount(() => editor.signals.sceneGraphChanged.remove(sweep))
}
