// @ts-nocheck
// Bind-pose bone transforms are kept out of userData (and therefore out of
// object.toJSON()) since userData is JSON-serialized for undo history and
// project save/export, and a live THREE.Object3D reference there would
// break serialization.
const bindPoseBones = new WeakMap()

async function snapshotBindPose(scene) {
  let hasSkinnedMesh = false

  scene.traverse(function (node) {
    if (node.isSkinnedMesh) hasSkinnedMesh = true
  })

  if (!hasSkinnedMesh) return

  const SkeletonUtils = await import("three/addons/utils/SkeletonUtils.js")
  const bindPoseRoot = SkeletonUtils.clone(scene)

  const pairBones = function (node, clonedNode) {
    if (node.isBone) bindPoseBones.set(node, clonedNode)

    const children = node.children
    const clonedChildren = clonedNode.children

    for (let i = 0; i < children.length; i++) {
      pairBones(children[i], clonedChildren[i])
    }
  }

  pairBones(scene, bindPoseRoot)
}

function getBindPoseBone(bone) {
  return bindPoseBones.get(bone)
}

export { snapshotBindPose, getBindPoseBone }
