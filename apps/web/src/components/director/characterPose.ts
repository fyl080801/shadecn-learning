import * as THREE from "three"
import { getBindPoseBone } from "@/components/three-editor/SkeletonBindPose"

// 以下坐标轴约定是经验推导得出（非猜测）：通过 three.js 自带的 FBXLoader
// 单独加载 male-base.fbx，逐骨骼检查绑定姿态下每个局部坐标轴指向的世界方向，
// 并在肘部/膝部进行了经验性的铰链测试。由此得出两点从源 FBX 文件中
// 不易察觉的结论：
//   - FBXLoader 会去除骨骼名中的":"，因此 "mixamorig:LeftArm" 在运行时
//     变为 "mixamorigLeftArm"——下文所有名称均已反映此变化。
//   - 每个命名骨骼在每个蒙皮网格中作为*独立*的 Object3D 存在，但
//     副本并非独立的兄弟节点——其中一个网格的骨骼链是真正的层级结构，
//     另一个网格的同名骨骼作为单位变换的叶子子节点拼接其上
//     （见 findBonesByName，它仅旋转非叶子实例）。
//
// 脊柱族骨骼（Hips/Spine/Spine1/Spine2/Neck/Head）的局部
// X/Y/Z 分别对齐世界横向/纵向/深度方向。手臂族骨骼的局部 Y 沿手臂自身长度方向
// （T-pose，即世界横向），局部 Z 沿世界纵向，局部 X 沿世界深度方向。
// 腿部族骨骼的局部 Y 沿腿自身长度方向（世界纵向），局部 X 沿世界横向，
// 局部 Z 沿世界深度方向。左右对称对无需符号翻转——镜像绑定的
// 装配已将该约定烘焙到每侧的局部坐标系中。

export type PoseValues = Record<string, number>

export interface AxisControl {
  key: string
  axis: "x" | "y" | "z"
  // 翻转正滑块值所产生的物理方向。
  // 在骨骼的局部坐标轴（经经验验证——见模块注释）指向与控件标签所暗示的
  // 方向相反时需要：例如绕肩部局部 X 轴的正向旋转实际上是降低手臂，
  // 因此肩部外展需要 -1 以保证"正值 = 抬起"；绕膝部局部 X 轴的正向旋转
  // 使小腿前摆（伸展），因此膝部弯曲需要 -1 以保证"正值 = 屈曲"。
  sign?: 1 | -1
  label: string
  min: number
  max: number
}

export interface BoneGroup {
  groupKey: string
  label: string
  bones: string[]
  controls: AxisControl[]
}

export const BONE_GROUPS: BoneGroup[] = [
  {
    groupKey: "body",
    label: "身体",
    bones: ["mixamorigHips"],
    controls: [
      { key: "body_lean", axis: "x", label: "前倾", min: -45, max: 45 },
      { key: "body_turn", axis: "y", label: "转身", min: -90, max: 90 },
      { key: "body_tilt", axis: "z", label: "侧倾", min: -45, max: 45 }
    ]
  },
  {
    groupKey: "torso",
    label: "躯干",
    bones: ["mixamorigSpine", "mixamorigSpine1", "mixamorigSpine2"],
    controls: [
      { key: "torso_lean", axis: "x", label: "前倾", min: -45, max: 45 },
      { key: "torso_twist", axis: "y", label: "扭转", min: -60, max: 60 },
      { key: "torso_tilt", axis: "z", label: "侧倾", min: -45, max: 45 }
    ]
  },
  {
    groupKey: "head",
    label: "头部",
    bones: ["mixamorigNeck", "mixamorigHead"],
    controls: [
      { key: "head_nod", axis: "x", label: "点头", min: -45, max: 45 },
      { key: "head_turn", axis: "y", label: "转头", min: -80, max: 80 },
      { key: "head_tilt", axis: "z", label: "歪头", min: -40, max: 40 }
    ]
  },
  {
    groupKey: "leftShoulder",
    label: "左",
    bones: ["mixamorigLeftArm"],
    controls: [
      {
        key: "leftShoulder_raise",
        axis: "z",
        label: "前举",
        min: -90,
        max: 150
      },
      {
        key: "leftShoulder_abduct",
        axis: "x",
        sign: -1,
        label: "外展",
        min: -85,
        max: 90
      },
      { key: "leftShoulder_twist", axis: "y", label: "扭转", min: -80, max: 80 }
    ]
  },
  {
    groupKey: "rightShoulder",
    label: "右",
    bones: ["mixamorigRightArm"],
    controls: [
      {
        key: "rightShoulder_raise",
        axis: "z",
        sign: -1,
        label: "前举",
        min: -90,
        max: 150
      },
      {
        key: "rightShoulder_abduct",
        axis: "x",
        sign: -1,
        label: "外展",
        min: -85,
        max: 90
      },
      {
        key: "rightShoulder_twist",
        axis: "y",
        label: "扭转",
        min: -80,
        max: 80
      }
    ]
  },
  {
    groupKey: "leftElbow",
    label: "左",
    bones: ["mixamorigLeftForeArm"],
    controls: [
      { key: "leftElbow_bend", axis: "z", label: "弯曲", min: 0, max: 140 }
    ]
  },
  {
    groupKey: "rightElbow",
    label: "右",
    bones: ["mixamorigRightForeArm"],
    controls: [
      {
        key: "rightElbow_bend",
        axis: "z",
        sign: -1,
        label: "弯曲",
        min: 0,
        max: 140
      }
    ]
  },
  {
    groupKey: "leftHip",
    label: "左",
    bones: ["mixamorigLeftUpLeg"],
    controls: [
      { key: "leftHip_lift", axis: "x", label: "前抬", min: -30, max: 110 },
      { key: "leftHip_abduct", axis: "z", label: "外展", min: -45, max: 45 },
      { key: "leftHip_twist", axis: "y", label: "扭转", min: -60, max: 60 }
    ]
  },
  {
    groupKey: "rightHip",
    label: "右",
    bones: ["mixamorigRightUpLeg"],
    controls: [
      { key: "rightHip_lift", axis: "x", label: "前抬", min: -30, max: 110 },
      {
        key: "rightHip_abduct",
        axis: "z",
        sign: -1,
        label: "外展",
        min: -45,
        max: 45
      },
      { key: "rightHip_twist", axis: "y", label: "扭转", min: -60, max: 60 }
    ]
  },
  {
    groupKey: "leftKnee",
    label: "左",
    bones: ["mixamorigLeftLeg"],
    controls: [
      {
        key: "leftKnee_bend",
        axis: "x",
        sign: -1,
        label: "弯曲",
        min: 0,
        max: 140
      }
    ]
  },
  {
    groupKey: "rightKnee",
    label: "右",
    bones: ["mixamorigRightLeg"],
    controls: [
      {
        key: "rightKnee_bend",
        axis: "x",
        sign: -1,
        label: "弯曲",
        min: 0,
        max: 140
      }
    ]
  }
]

export const ALL_CONTROL_KEYS: string[] = BONE_GROUPS.flatMap((g) =>
  g.controls.map((c) => c.key)
)

export function createEmptyPoseValues(): PoseValues {
  const values: PoseValues = {}
  for (const key of ALL_CONTROL_KEYS) values[key] = 0
  return values
}

export function isCharacterObject(object: any): boolean {
  if (!object) return false
  let found = false
  object.traverse((child: any) => {
    if (child.isSkinnedMesh) found = true
  })
  return found
}

// 导演控制台的场景没有显式灯光——每个对象仅由 scene.environment
// （由天空颜色烘焙的 PMREM）照明。对于平坦的灰色填充尚可，但在 Mixamo 角色的
// MeshPhongMaterial 上会呈现为沿各肢体轮廓的刺眼亮带，容易被误认为是
// 骨骼/骨架叠加层（已确认：将 scene.environment 置为 null 会使角色变为
// 纯黑剪影，因此它确实是唯一光源，而非多余的杂散反射）。切换为
// MeshBasicMaterial 使角色完全不受光照——纯色剪影，不受任何当前或未来
// 场景光照影响——这是在不为角色添加不同于场景其余部分的专用灯光配置的
// 情况下消除亮带的唯一方法。
//
// 幂等（已是 MeshBasicMaterial 的网格会被跳过），因为材质类型本身会被
// 自动保存序列化/还原（THREE.ObjectLoader 忠实还原保存时的材质类型），
// 而"为什么要用 unlit"这个意图并不会一并保存——角色一旦以旧的
// MeshPhongMaterial 状态被自动保存过，仅在创建时调用一次这个替换是不够的，
// 必须在角色进入场景的每个入口（预设创建、自动保存恢复、拖拽导入的 FBX）
// 都调用它，见 useCharacterUnlitMaterial。
export function applyUnlitCharacterMaterial(object: any) {
  object.traverse((child: any) => {
    if (
      child.isMesh &&
      child.material &&
      !Array.isArray(child.material) &&
      !child.material.isMeshBasicMaterial
    ) {
      const old = child.material
      child.material = new THREE.MeshBasicMaterial({ color: old.color })
      old.dispose()
    }
  })
}

// Editor.ts 的 addHelper 会自动为遍历期间遇到的每个 SkinnedMesh 挂载一个
// 内置 THREE.SkeletonHelper（蓝/绿色的骨骼连线调试线），并分别为每个根骨骼
// （其自身父级不是骨骼的骨骼）挂载一个——两条独立的代码路径，各自在
// editor.helpers 中以网格 id 或骨骼 id 为键注册各自条目。在此渲染器的设置下，
// 以网格为键的辅助器忽略自身的 `.visible` 标志（经实验验证：切换一个不产生
// 任何像素变化），但以根骨骼为键的则不然——它才是真正持久的线。两者都需要
// 清除；可用的替代方案由下方的 ensureSkeletonLines 构建。
export function removeStockSkeletonHelpers(editor: any, object: any) {
  object.traverse((child: any) => {
    const isRootBone = child.isBone && child.parent && !child.parent.isBone
    if ((child.isSkinnedMesh || isRootBone) && editor.helpers[child.id]) {
      editor.removeHelper(child)
    }
  })
}

export const skeletonLineName = (character: any) =>
  `__skeletonLines__${character.uuid}`

// 基于 BONE_GROUPS 所暴露的骨骼构建（或刷新）骨骼连线叠加层，而非内置
// SkeletonHelper（后者既将每个重复装配骨骼都画为独立段——噪声大，见本文件
// 顶部 findBonesByName 的叶子骨骼重复说明——又在此忽略其 `.visible` 标志）。
// 线段将每个可摆姿骨骼连接到其最近的可摆姿祖先，沿骨骼自身的父级链遍历，
// 使左右叶子与真实副本各获得固定到正确骨骼链的独立线段。
//
// 每次选中/姿势改变以及角色进入场景时都应调用（见 DirectorObjectPropertiesPanel.vue
// 的 syncFromObject 和 useCharacterSkeletonOverlay 的场景扫描），以保持叠加层
// 追踪实时摆姿——位置作为全新属性重建，而非在 onBeforeRender 回调中修改，
// 因为经实验验证，从 onBeforeRender 更新的同一 DynamicDrawUsage 属性在此
// 渲染器下实际上永远不会到达屏幕，而直接替换属性则可以。
//
// 位于 editor.sceneHelpers 中（如同变换 gizmo/选中框），而非作为角色的子节点
// 添加到 editor.scene：sceneHelpers 通道在之后渲染，在同一个深度缓冲区上且
// autoClear 关闭，这正是让 depthTest:false 穿透已渲染的不透明身体的关键——
// 经实验验证，相同的线挂载在角色下则做不到。sceneHelpers 没有自身的变换，
// 因此骨骼位置直接以世界空间坐标使用。
export function ensureSkeletonLines(editor: any, character: any): any {
  const name = skeletonLineName(character)
  let line = editor.sceneHelpers.children.find((c: any) => c.name === name)

  const poseBoneNames = new Set(BONE_GROUPS.flatMap((group) => group.bones))
  const segments: { from: any; to: any }[] = []
  for (const boneName of poseBoneNames) {
    for (const bone of findBonesByName(character, boneName)) {
      let ancestor = bone.parent
      while (ancestor?.isBone && !poseBoneNames.has(ancestor.name)) {
        ancestor = ancestor.parent
      }
      if (ancestor?.isBone && poseBoneNames.has(ancestor.name)) {
        segments.push({ from: ancestor, to: bone })
      }
    }
  }

  const worldPos = new THREE.Vector3()
  const raw: number[] = []
  for (const segment of segments) {
    segment.from.getWorldPosition(worldPos)
    raw.push(worldPos.x, worldPos.y, worldPos.z)
    segment.to.getWorldPosition(worldPos)
    raw.push(worldPos.x, worldPos.y, worldPos.z)
  }

  if (!line) {
    const geometry = new THREE.BufferGeometry()
    const material = new THREE.LineBasicMaterial({
      color: 0xffe14d,
      depthTest: false
    })
    line = new THREE.LineSegments(geometry, material)
    line.name = name
    line.frustumCulled = false
    editor.sceneHelpers.add(line)
  }
  line.geometry.setAttribute("position", new THREE.Float32BufferAttribute(raw, 3))

  return line
}

export function removeSkeletonLines(editor: any, character: any) {
  const name = skeletonLineName(character)
  const existing = editor.sceneHelpers.children.find((c: any) => c.name === name)
  if (existing) {
    editor.sceneHelpers.remove(existing)
    existing.geometry.dispose()
    existing.material.dispose()
  }
}

// Mixamo 配对的 Surface/Joints 网格在每个关节处各携带一个同名骨骼，
// 但两份副本并非独立的兄弟节点：其中一个网格的骨骼链是真正的父子层级，
// 另一个网格的同名骨骼作为单位变换的*叶子*子节点拼接在真正的骨骼之下
// （这是 FBX 导出的特性，在 Y Bot 和 X Bot 上均经实验确认——哪个网格
// 是"真正骨骼链"、哪个是"叶子"因文件而异）。叶子骨骼的世界变换完全
// 继承自其同名父节点；在其上叠加自身的旋转会使该关节的每个姿势编辑被
// 重复应用，并在其下方的每个关节进一步累积——这正是导致手臂/腿部
// 看起来骨骼"连接"错误的原因。只有非叶子（真正骨骼链）实例才应被旋转；
// 叶子节点必须保持不动，以便干净地继续继承。
export function findBonesByName(root: any, name: string): any[] {
  const bones: any[] = []
  root.traverse((child: any) => {
    if (child.isBone && child.name === name && child.parent?.name !== name) {
      bones.push(child)
    }
  })
  return bones
}

function applyBoneRotation(
  bone: any,
  degrees: { x: number; y: number; z: number }
) {
  const bind = getBindPoseBone(bone)
  const restQuaternion = bind ? bind.quaternion : bone.quaternion
  const delta = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(degrees.x),
      THREE.MathUtils.degToRad(degrees.y),
      THREE.MathUtils.degToRad(degrees.z),
      "XYZ"
    )
  )
  bone.quaternion.copy(restQuaternion).multiply(delta)
}

// 将 `values` 中每个控件的值应用到角色骨骼上，
// 从头重新计算每个受影响骨骼的完整旋转（绑定姿态 + 该骨骼所有坐标轴的增量），
// 而非增量式计算——因此设置一个滑块绝不会固化来自先前无关编辑的陈旧状态。
export function applyPoseValues(root: any, values: PoseValues) {
  for (const group of BONE_GROUPS) {
    const degrees = { x: 0, y: 0, z: 0 }
    for (const control of group.controls) {
      degrees[control.axis] = (values[control.key] ?? 0) * (control.sign ?? 1)
    }

    const boneCount = group.bones.length
    const perBoneDegrees =
      boneCount > 1
        ? {
            x: degrees.x / boneCount,
            y: degrees.y / boneCount,
            z: degrees.z / boneCount
          }
        : degrees

    for (const boneName of group.bones) {
      for (const bone of findBonesByName(root, boneName)) {
        applyBoneRotation(bone, perBoneDegrees)
      }
    }
  }
}

export interface PosePresetEntry {
  key: string
  label: string
}

// 网格顺序与参考布局一致：4 列 x 5 行。
export const POSE_PRESET_LIST: PosePresetEntry[] = [
  { key: "standing", label: "站立" },
  { key: "tpose", label: "T型" },
  { key: "walking", label: "行走" },
  { key: "running", label: "跑步" },
  { key: "sitting", label: "坐姿" },
  { key: "crouching", label: "蹲下" },
  { key: "kneelOne", label: "单膝跪" },
  { key: "kneelTwo", label: "双膝跪" },
  { key: "handsOnHips", label: "叉腰" },
  { key: "leaning", label: "倚靠" },
  { key: "bowing", label: "鞠躬" },
  { key: "thinking", label: "思考" },
  { key: "fighting", label: "格斗" },
  { key: "kicking", label: "踢球" },
  { key: "throwing", label: "投掷" },
  { key: "pushing", label: "推进" },
  { key: "waving", label: "招手" },
  { key: "reaching", label: "伸手" },
  { key: "armsCrossed", label: "抱臂" },
  { key: "onPhone", label: "看手机" }
]

// 为导演走位编排手写的起始姿势，而非动作捕捉数据——
// 作为基准已足够，预期之后会用手动滑块微调。未列出的每个字段默认为 0。
export const POSE_PRESETS: Record<string, Partial<PoseValues>> = {
  standing: {
    leftShoulder_abduct: -80,
    rightShoulder_abduct: -80,
    leftElbow_bend: 8,
    rightElbow_bend: 8
  },
  tpose: {},
  walking: {
    leftHip_lift: 22,
    rightHip_lift: -18,
    leftKnee_bend: 15,
    rightKnee_bend: 30,
    leftShoulder_raise: -18,
    leftShoulder_abduct: -70,
    rightShoulder_raise: 15,
    rightShoulder_abduct: -70,
    leftElbow_bend: 20,
    rightElbow_bend: 15,
    body_turn: -3,
    torso_twist: -5
  },
  running: {
    leftHip_lift: 45,
    rightHip_lift: -35,
    leftKnee_bend: 70,
    rightKnee_bend: 40,
    leftShoulder_raise: -35,
    leftShoulder_abduct: -60,
    rightShoulder_raise: 35,
    rightShoulder_abduct: -60,
    leftElbow_bend: 80,
    rightElbow_bend: 70,
    body_lean: 8,
    torso_lean: 6,
    torso_twist: -8
  },
  sitting: {
    leftHip_lift: 85,
    rightHip_lift: 85,
    leftKnee_bend: 90,
    rightKnee_bend: 90,
    leftShoulder_abduct: -70,
    rightShoulder_abduct: -70,
    leftElbow_bend: 15,
    rightElbow_bend: 15,
    body_lean: -3
  },
  crouching: {
    leftHip_lift: 100,
    rightHip_lift: 100,
    leftKnee_bend: 115,
    rightKnee_bend: 115,
    torso_lean: 25,
    body_lean: 10,
    leftShoulder_raise: 20,
    leftShoulder_abduct: -20,
    rightShoulder_raise: 20,
    rightShoulder_abduct: -20,
    leftElbow_bend: 30,
    rightElbow_bend: 30
  },
  kneelOne: {
    leftHip_lift: 85,
    leftKnee_bend: 90,
    rightHip_lift: 110,
    rightHip_abduct: 10,
    rightKnee_bend: 140,
    torso_lean: 5,
    body_lean: 3,
    leftShoulder_abduct: -20,
    rightShoulder_abduct: -20,
    leftElbow_bend: 20,
    rightElbow_bend: 20
  },
  kneelTwo: {
    leftHip_lift: 95,
    rightHip_lift: 95,
    leftKnee_bend: 140,
    rightKnee_bend: 140,
    leftShoulder_abduct: -30,
    rightShoulder_abduct: -30
  },
  handsOnHips: {
    leftShoulder_raise: 5,
    leftShoulder_abduct: -15,
    leftShoulder_twist: 30,
    leftElbow_bend: 100,
    rightShoulder_raise: -5,
    rightShoulder_abduct: -15,
    rightShoulder_twist: -30,
    rightElbow_bend: 100,
    torso_tilt: 3
  },
  leaning: {
    body_tilt: 18,
    torso_tilt: 12,
    body_turn: 10,
    leftShoulder_abduct: -75,
    rightShoulder_abduct: -30,
    rightShoulder_raise: -10,
    rightElbow_bend: 25,
    leftHip_abduct: 10,
    rightHip_abduct: -6
  },
  bowing: {
    torso_lean: 45,
    body_lean: 15,
    head_nod: 15,
    leftShoulder_abduct: -70,
    rightShoulder_abduct: -70
  },
  thinking: {
    rightShoulder_raise: 45,
    rightShoulder_abduct: -15,
    rightElbow_bend: 125,
    leftShoulder_abduct: -75,
    head_tilt: 8,
    head_turn: -12,
    head_nod: 5,
    torso_twist: 6
  },
  fighting: {
    leftHip_lift: 18,
    rightHip_lift: -12,
    leftKnee_bend: 25,
    rightKnee_bend: 35,
    leftShoulder_raise: 35,
    leftShoulder_abduct: -25,
    leftElbow_bend: 95,
    rightShoulder_raise: 40,
    rightShoulder_abduct: -30,
    rightElbow_bend: 100,
    torso_twist: 12,
    body_turn: 15
  },
  kicking: {
    body_lean: -4,
    body_turn: -7,
    body_tilt: -1,
    torso_lean: -5,
    torso_twist: -10,
    torso_tilt: 5,
    head_nod: 5,
    head_turn: -10,
    leftShoulder_raise: -20,
    leftShoulder_abduct: 30,
    rightShoulder_raise: 20,
    rightShoulder_abduct: 25,
    leftElbow_bend: 40,
    rightElbow_bend: 35,
    leftHip_lift: -10,
    rightHip_lift: 80,
    leftKnee_bend: 10,
    rightKnee_bend: 20
  },
  throwing: {
    rightShoulder_raise: -40,
    rightShoulder_abduct: -50,
    rightShoulder_twist: -20,
    rightElbow_bend: 90,
    leftShoulder_raise: 30,
    leftShoulder_abduct: -20,
    leftElbow_bend: 15,
    leftHip_lift: 20,
    rightHip_lift: -10,
    torso_twist: -25,
    body_turn: -20
  },
  pushing: {
    leftShoulder_raise: 70,
    leftShoulder_abduct: -15,
    leftElbow_bend: 20,
    rightShoulder_raise: 70,
    rightShoulder_abduct: -15,
    rightElbow_bend: 20,
    leftHip_lift: 15,
    rightHip_lift: -10,
    leftKnee_bend: 10,
    torso_lean: 15,
    body_lean: 8
  },
  waving: {
    rightShoulder_raise: 15,
    rightShoulder_abduct: -85,
    rightShoulder_twist: 20,
    rightElbow_bend: 55,
    leftShoulder_abduct: -78,
    head_turn: 15,
    head_tilt: 5
  },
  reaching: {
    rightShoulder_raise: 75,
    rightShoulder_abduct: -10,
    rightElbow_bend: 10,
    leftShoulder_abduct: -78,
    torso_lean: 10,
    torso_twist: -8,
    body_turn: -6
  },
  armsCrossed: {
    leftShoulder_raise: 25,
    leftShoulder_abduct: -20,
    leftShoulder_twist: 20,
    leftElbow_bend: 115,
    rightShoulder_raise: 25,
    rightShoulder_abduct: -20,
    rightShoulder_twist: -20,
    rightElbow_bend: 115,
    torso_lean: 3
  },
  onPhone: {
    rightShoulder_raise: 40,
    rightShoulder_abduct: -15,
    rightElbow_bend: 110,
    leftShoulder_abduct: -78,
    head_nod: 30,
    head_tilt: 5,
    torso_lean: 5
  }
}

export function resolvePosePreset(key: string): PoseValues {
  const values = createEmptyPoseValues()
  Object.assign(values, POSE_PRESETS[key] ?? {})
  return values
}
