import * as THREE from "three"

// 绑定姿态的骨骼变换不存放在 userData 中（因此也不在
// object.toJSON() 中），因为 userData 会被 JSON 序列化用于撤销历史和
// 项目保存/导出，历史上这里存放的是活跃的 THREE.Object3D 引用，会破坏序列化。
interface BindPoseTransform {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  scale: THREE.Vector3
}

const bindPoseBones = new WeakMap<THREE.Object3D, BindPoseTransform>()

// 导入时调用：把加载出的静置姿态逐骨骼记录为绑定姿态基准。
// 保持 async 签名以兼容 Loader.ts 中的多处 await 调用点。
async function snapshotBindPose(scene: THREE.Object3D) {
  scene.traverse(function (node: any) {
    if (node.isBone && !bindPoseBones.has(node)) {
      bindPoseBones.set(node, {
        position: node.position.clone(),
        quaternion: node.quaternion.clone(),
        scale: node.scale.clone()
      })
    }
  })
}

function getBindPoseBone(bone: THREE.Object3D) {
  return bindPoseBones.get(bone)
}

// 判断某个角色根节点是否已经有绑定姿态记录——WeakMap 以骨骼对象本身为键，
// 而场景恢复（ObjectLoader.parse）产生的是全新的 Object3D 实例，
// 因此每次页面刷新后都需要重新探测，不能假设"曾经记录过"就意味着现在也有。
function hasBindPose(object: THREE.Object3D): boolean {
  let bone: THREE.Object3D | undefined
  object.traverse((child: any) => {
    if (!bone && child.isBone) bone = child
  })
  return bone !== undefined && bindPoseBones.has(bone)
}

// node 相对 ancestor 的变换：从 ancestor 的直接子节点到 node 的局部矩阵链乘积。
// 用 position/quaternion/scale 现场 compose 而非读 .matrix，避免依赖
// matrixAutoUpdate 时序。node 不在 ancestor 之下时返回 null。
function relativeMatrix(node: any, ancestor: any): THREE.Matrix4 | null {
  const result = new THREE.Matrix4()
  const local = new THREE.Matrix4()
  for (let n = node; n !== ancestor; n = n.parent) {
    if (!n) return null
    local.compose(n.position, n.quaternion, n.scale)
    result.premultiply(local)
  }
  return result
}

// 页面刷新后场景经 ObjectLoader 重建，骨骼是全新实例，上面的 WeakMap 记录
// 全部丢失；且骨骼此刻摆的是"保存时的姿态"而非绑定姿态，直接补拍快照会把
// 已摆好的姿势固化为基准——之后每次套用姿势预设都在其上叠加，骨架依旧混乱。
//
// 真正的绑定姿态其实被 three.js 自己持久化了：skeleton.boneInverses 是绑定
// 时每根骨骼世界矩阵的逆，随 SkinnedMesh 一起序列化/恢复。据此可精确还原
// 每根骨骼的局部绑定变换：
//   worldBind_i = boneInverses[i]⁻¹
//   localBind_i = worldBind_parent⁻¹ * worldBind_i
// 根骨骼（父级不是骨骼）的 worldBind_parent 取不到 boneInverses，改用
// mesh.bindMatrix（= 绑定时 mesh 的世界矩阵，同样被序列化）推回：姿势编辑
// 只旋转骨骼，非骨骼节点的局部变换自绑定后从未变化，因此
//   rootWorldBind = bindMatrix * (root→mesh 局部链)⁻¹
//   parentWorldBind = rootWorldBind * (root→parent 局部链)
// 该推导只依赖序列化过的量与未被姿势编辑触碰的节点，与角色根节点当前被
// 移到哪里无关。
function recoverBindPose(root: THREE.Object3D) {
  // 先跨所有蒙皮网格收集每根骨骼的绑定世界矩阵。重复装配的叶子骨骼
  // （见 characterPose.ts 模块注释）在另一张 skeleton 里才是正式成员，
  // 汇总后其父骨骼（属于另一张 skeleton）也能查到绑定世界矩阵。
  const worldBind = new Map<THREE.Object3D, THREE.Matrix4>()
  const meshForBone = new Map<THREE.Object3D, any>()

  root.traverse((mesh: any) => {
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return
    const { bones, boneInverses } = mesh.skeleton
    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i]!
      if (worldBind.has(bone)) continue
      worldBind.set(bone, new THREE.Matrix4().copy(boneInverses[i]!).invert())
      meshForBone.set(bone, mesh)
    }
  })

  for (const [bone, world] of worldBind) {
    if (bindPoseBones.has(bone)) continue

    const parent: any = bone.parent
    let parentWorld: THREE.Matrix4 | null
    if (parent && worldBind.has(parent)) {
      parentWorld = worldBind.get(parent)!.clone()
    } else if (parent) {
      const mesh = meshForBone.get(bone)
      const meshRel = relativeMatrix(mesh, root)
      const parentRel = relativeMatrix(parent, root)
      parentWorld =
        meshRel && parentRel
          ? new THREE.Matrix4()
              .copy(mesh.bindMatrix)
              .multiply(meshRel.invert())
              .multiply(parentRel)
          : null
    } else {
      parentWorld = new THREE.Matrix4()
    }
    if (!parentWorld) continue

    const localBind = parentWorld.invert().multiply(world)
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    localBind.decompose(position, quaternion, scale)
    bindPoseBones.set(bone, { position, quaternion, scale })
  }
}

export { snapshotBindPose, getBindPoseBone, hasBindPose, recoverBindPose }
