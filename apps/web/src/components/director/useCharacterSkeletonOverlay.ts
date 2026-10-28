import { onBeforeUnmount, onMounted } from "vue"

import {
  ensureSkeletonLines,
  isCharacterObject,
  removeStockSkeletonHelpers
} from "./characterPose"
import {
  hasBindPose,
  recoverBindPose
} from "@/components/three-editor/SkeletonBindPose"

// DirectorObjectPropertiesPanel.vue 只在角色被选中时（syncFromObject 的角色
// 分支）才调用 removeStockSkeletonHelpers/ensureSkeletonLines，因此页面刷新后、
// 用户尚未选中任何角色之前，Editor.ts 的 addHelper 在场景恢复期间自动为每个
// 骨骼网格挂载的内置 THREE.SkeletonHelper（蓝/绿色连线）会原样显示，直到第一次
// 选中角色才被替换成自定义的黄色叠加层——与 useCharacterUnlitMaterial 是
// 同一类问题（一次性修复只在创建/选中时触发，没有覆盖场景恢复路径）。
//
// 同一类问题还有第三种表现：绑定姿态记录（SkeletonBindPose.ts 的
// bindPoseBones）只在 Loader.ts 首次导入模型时以骨骼对象本身为 WeakMap 键
// 写入，且明确不随 toJSON 序列化。场景经 ObjectLoader 恢复后产生的是全新
// 骨骼实例，记录因此丢失——characterPose.ts 的 applyBoneRotation 在没有
// 记录时会退化为把骨骼"当前"四元数当成基准去叠加旋转增量，导致刷新后的
// 角色每次调整姿势预设/滑块都在上一次结果上继续叠加，很快就转得面目全非；
// 而新添加的模型走的是 Loader.ts 的导入路径，记录始终存在，所以问题只在
// "刷新后已有的角色"上出现。注意不能在恢复后简单补拍当前姿态——骨骼此刻
// 摆的是保存时的姿势而非绑定姿态，补拍会把它固化为基准，预设仍会在其上
// 叠加；recoverBindPose 改从随场景一起序列化的 skeleton.boneInverses /
// mesh.bindMatrix 反推真正的绑定姿态。
//
// 在此对 sceneGraphChanged 做一次幂等扫描，覆盖场景中的所有角色，使其在
// 场景恢复完成时就立即隐藏内置骨骼线（骨骼线仅在面板"姿势"选项卡激活时才
// 可见，由 DirectorObjectPropertiesPanel.vue 联动），并恢复缺失的绑定姿态
// 基准，而不必等待交互触发。
export function useCharacterSkeletonOverlay(editor: any) {
  function sweep() {
    for (const object of editor.scene.children) {
      if (!isCharacterObject(object)) continue
      removeStockSkeletonHelpers(editor, object)
      ensureSkeletonLines(editor, object).visible = false

      if (!hasBindPose(object)) recoverBindPose(object)
    }
  }

  onMounted(() => editor.signals.sceneGraphChanged.add(sweep))
  onBeforeUnmount(() => editor.signals.sceneGraphChanged.remove(sweep))
}
